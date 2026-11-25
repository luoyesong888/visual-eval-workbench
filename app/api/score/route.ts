/**
 * Objective scoring bridge: Next.js -> local Python scorer.
 *
 * The workbench UI scores by hand. This route supplies the automatic numbers by
 * forwarding an asset to the Python service (webapp/score_server.py), which runs
 * VBench for video and pyiqa for images.
 *
 * Why the asset is materialised on disk first: the Python side needs a real file
 * path (VBench decodes with decord, pyiqa opens with PIL / torchvision), and
 * video URLs handed back by the vendors expire after ~24h anyway. Caching them
 * under .data/ makes the score reproducible later.
 *
 * Start the scorer first:
 *   cd eval-suite && ./bin/evalctl score-server --port 7861
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

const SCORER = process.env.SCORE_SERVICE_URL ?? "http://127.0.0.1:7861";
const CACHE_DIR = path.join(process.cwd(), ".data", "scored");

interface ScoreBody {
  url?: string;
  kind?: "video" | "image";
  prompt?: string;
  id?: string;
}

const EXT_BY_KIND = { video: ".mp4", image: ".png" } as const;

function cachePath(url: string, kind: "video" | "image"): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${hash}${EXT_BY_KIND[kind]}`);
}

async function materialise(url: string, kind: "video" | "image"): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const dest = cachePath(url, kind);

  // Reuse a previous download - scoring the same URL twice is common when the
  // user re-runs a slot or rescores after switching metrics.
  try {
    const existing = await readFile(dest);
    if (existing.byteLength > 0) return dest;
  } catch {
    /* not cached yet */
  }

  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL");
    const buf = Buffer.from(url.slice(comma + 1), "base64");
    if (!buf.byteLength) throw new Error("empty data URL payload");
    await writeFile(dest, buf);
    return dest;
  }

  if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported url: ${url.slice(0, 60)}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.byteLength) throw new Error("downloaded asset is empty");
  await writeFile(dest, buf);
  return dest;
}

export async function POST(request: Request) {
  let body: ScoreBody;
  try {
    body = (await request.json()) as ScoreBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const kind = body.kind ?? "video";
  if (kind !== "video" && kind !== "image") {
    return NextResponse.json({ error: `bad kind: ${kind}` }, { status: 400 });
  }
  if (!body.url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  let file: string;
  try {
    file = await materialise(body.url, kind);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "asset download failed" },
      { status: 502 },
    );
  }

  const payload = {
    items: [{ id: body.id ?? "target", path: file, prompt: body.prompt ?? "" }],
  };

  try {
    const res = await fetch(`${SCORER}/score/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { error: (data.detail as string) ?? `scorer returned ${res.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    const hint =
      error instanceof Error && /fetch failed|ECONNREFUSED/i.test(error.message)
        ? "本地打分服务未启动：cd eval-suite && ./bin/evalctl score-server --port 7861"
        : error instanceof Error
          ? error.message
          : "scorer unreachable";
    return NextResponse.json({ error: hint }, { status: 503 });
  }
}

export async function GET() {
  try {
    const res = await fetch(`${SCORER}/health`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json({ ok: res.ok, scorer: data });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "本地打分服务未启动",
        hint: "cd eval-suite && ./bin/evalctl score-server --port 7861",
      },
      { status: 503 },
    );
  }
}
