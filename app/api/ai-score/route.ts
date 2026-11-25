/**
 * AI judging: an MLLM scores a generated asset against the rubric in
 * lib/eval-dims.ts.
 *
 * Why an MLLM instead of the VBench/pyiqa pipeline that already exists:
 * those metrics answer "is the picture technically clean and self-consistent",
 * not "did it draw the red cup on the blue table". Detector-based grounding
 * (GenEval, T2I-CompBench) needs mmdet/detectron2, which has no arm64 build.
 * A vision-language judge covers the semantic dimensions on commodity hardware,
 * at the cost of being subjective - hence the UI shows its reasoning per
 * dimension, and repeat runs are expected to wobble by about one point.
 *
 * Video is judged from six evenly-spaced frames tiled into one contact sheet:
 * sending 30 individual frames costs 5x more tokens for little extra signal,
 * and most MLLM vision encoders downsample video input anyway.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { dimsFor, EvalKind } from "@/lib/eval-dims";

export const runtime = "nodejs";
export const maxDuration = 900;

const run = promisify(execFile);
const CACHE_DIR = path.join(process.cwd(), ".data", "judged");
const FRAMES = 6;

interface JudgeConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

interface JudgeBody {
  url?: string;
  kind?: EvalKind;
  prompt?: string;
  judge?: JudgeConfig;
  dims?: string[];
}

const DEFAULT_BASE = process.env.JUDGE_BASE_URL ?? "https://api.openai.com/v1";
const DEFAULT_MODEL = process.env.JUDGE_MODEL ?? "gpt-4o";

// ------------------------------------------------------------------ assets

function cachePath(url: string, suffix: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${hash}${suffix}`);
}

async function materialise(url: string, kind: EvalKind): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const dest = cachePath(url, kind === "video" ? ".mp4" : ".png");
  try {
    const existing = await readFile(dest);
    if (existing.byteLength > 0) return dest;
  } catch {
    /* not cached */
  }

  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL");
    const buf = Buffer.from(url.slice(comma + 1), "base64");
    if (!buf.byteLength) throw new Error("empty data URL");
    await writeFile(dest, buf);
    return dest;
  }
  if (!/^https?:\/\//i.test(url)) throw new Error("unsupported url");

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.byteLength) throw new Error("下载到的文件为空");
  await writeFile(dest, buf);
  return dest;
}

async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Six evenly spaced frames tiled 3x2 - one image in, whole clip described. */
async function contactSheet(video: string): Promise<string> {
  const dest = `${video}.sheet.jpg`;
  try {
    const cached = await readFile(dest);
    if (cached.byteLength > 0) return dest;
  } catch {
    /* build it */
  }

  const duration = await probeDuration(video);
  // Clamp so a 0.5s clip does not ask ffmpeg for 12 frames a second.
  const interval = duration > 0 ? Math.max(duration / FRAMES, 0.2) : 1;
  const filter =
    `fps=1/${interval.toFixed(3)},scale=384:-2,tile=3x2`;

  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", video,
    "-vf", filter,
    "-frames:v", "1",
    "-q:v", "3",
    dest,
  ]);
  const out = await readFile(dest);
  if (!out.byteLength) throw new Error("抽帧失败，视频可能无法解码");
  return dest;
}

const toDataUrl = async (file: string) => {
  const buf = await readFile(file);
  // Video is judged from a contact sheet (.jpg); only stills stay PNG.
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
};

// -------------------------------------------------------------------- judge

function buildPrompt(prompt: string, kind: EvalKind, dims: ReturnType<typeof dimsFor>) {
  const lines = dims.map(
    (dim, index) => `${index + 1}. ${dim.key}（${dim.label}）：${dim.guide}`,
  );
  const what =
    kind === "video"
      ? `这是一段 AI 生成的视频，下面这张图是从视频中**均匀抽取的 ${FRAMES} 帧**拼成的网格（从左到右、从上到下为时间先后顺序）。请把它当作整段视频来评。`
      : "这是一张 AI 生成的图片。";

  return `你是严格的 AIGC 视觉质量评审。${what}

用户给生成模型的提示词：
"""
${prompt}
"""

请按以下维度打分，每项必须是 1-5 的整数：
${lines.join("\n")}

打分纪律（很重要）：
- 严格评分。3 分代表"基本做到但有明显瑕疵"，是大多数结果的位置。只有无可挑剔才给 5 分，明显失败给 1-2 分。
- 只依据画面实际内容判断，不要因为提示词写得好就同情加分。
- 不要因为画风好看就提高"提示词遵循"的分；也不要因为提示词简单就压低"美学"的分。
- 每项给一句不超过 25 字的评语，指出具体依据（看到了什么）。

只输出 JSON，不要任何解释文字：
{"scores":{"维度key":整数,...},"reasons":{"维度key":"评语",...},"summary":"不超过 40 字的总体结论"}`;
}

function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("裁判模型没有返回合法 JSON");
  }
}

const clampScore = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
};

export async function POST(request: Request) {
  let body: JudgeBody;
  try {
    body = (await request.json()) as JudgeBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const kind: EvalKind = body.kind === "video" ? "video" : "image";
  if (!body.url) return NextResponse.json({ error: "url is required" }, { status: 400 });
  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const all = dimsFor(kind);
  const dims = body.dims?.length
    ? all.filter((dim) => body.dims?.includes(dim.key))
    : all;

  const judge = body.judge ?? {};
  const baseUrl = (judge.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const apiKey = judge.apiKey || process.env.OPENAI_API_KEY || "";
  const model = judge.model || DEFAULT_MODEL;
  if (!apiKey) {
    return NextResponse.json(
      { error: "缺少裁判模型 API Key，请在页面右上角填写", needJudge: true },
      { status: 400 },
    );
  }

  let imageUrl: string;
  try {
    const file = await materialise(body.url, kind);
    const shot = kind === "video" ? await contactSheet(file) : file;
    imageUrl = await toDataUrl(shot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "素材准备失败" },
      { status: 502 },
    );
  }

  const payload = {
    model,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(body.prompt, kind, dims) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  let raw: string;
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `裁判模型返回 ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
    };
    raw = data.choices?.[0]?.message?.content ?? "";
    if (!raw) return NextResponse.json({ error: "裁判模型返回空内容" }, { status: 502 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `调用裁判模型失败：${error.message}`
            : "调用裁判模型失败",
      },
      { status: 502 },
    );
  }

  let parsed: {
    scores?: Record<string, unknown>;
    reasons?: Record<string, unknown>;
    summary?: unknown;
  };
  try {
    parsed = extractJson(raw) as typeof parsed;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "解析失败",
        raw: raw.slice(0, 500),
      },
      { status: 502 },
    );
  }

  const scores: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  for (const dim of dims) {
    const value = clampScore(parsed.scores?.[dim.key]);
    if (value !== null) scores[dim.key] = value;
    const reason = parsed.reasons?.[dim.key];
    if (typeof reason === "string" && reason.trim()) reasons[dim.key] = reason.trim();
  }

  if (!Object.keys(scores).length) {
    return NextResponse.json(
      {
        error: "裁判模型没有给出任何有效分数",
        raw: raw.slice(0, 500),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    kind,
    scores,
    reasons,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    judge: model,
    dims: dims.map((dim) => ({ key: dim.key, label: dim.label })),
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModel: DEFAULT_MODEL,
    hasServerKey: Boolean(process.env.OPENAI_API_KEY),
    dims: {
      image: dimsFor("image").map((d) => d.key),
      video: dimsFor("video").map((d) => d.key),
    },
  });
}
