"use client";

/**
 * Deliberately minimal replacement for the upstream question-bank workbench.
 *
 * One prompt, N models, one result grid, one rubric table. No question bank, no
 * session history, no manual 1-5 clicking - the judge model does the scoring.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  LoaderCircle,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  loadSavedKeys,
  PROVIDERS,
  ProviderKey,
  saveKey,
} from "@/lib/provider-config";
import { VIDEO_PROVIDERS, VideoProviderKey } from "@/lib/video";
import { dimsFor, EvalKind, scoreWord } from "@/lib/eval-dims";

type AnyProviderKey = ProviderKey | VideoProviderKey;

interface Slot {
  id: string;
  provider: AnyProviderKey;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

interface SlotResult {
  status: "idle" | "running" | "ok" | "error";
  asset?: string;
  mediaType?: string;
  elapsed?: number;
  error?: string;
  scores?: Record<string, number>;
  reasons?: Record<string, string>;
  summary?: string;
  judging?: boolean;
  judgeError?: string;
}

interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const JUDGE_STORE = "visualbench.judge";
const MAX_SLOTS = 4;

const isVideoProvider = (key: AnyProviderKey): key is VideoProviderKey =>
  key in VIDEO_PROVIDERS;

const providerDef = (key: AnyProviderKey) =>
  isVideoProvider(key) ? VIDEO_PROVIDERS[key] : PROVIDERS[key];

const newSlot = (key: AnyProviderKey, id: string, keys: Record<string, string>): Slot => {
  const def = providerDef(key);
  return {
    id,
    provider: key,
    modelId: def.defaultModel,
    apiKey: keys[key] ?? "",
    baseUrl: ("defaultBaseUrl" in def ? def.defaultBaseUrl : undefined) ?? "",
  };
};

const defaultKeys = (kind: EvalKind): [AnyProviderKey, AnyProviderKey] =>
  kind === "image" ? ["custom", "openai"] : ["dashscope", "agnes"];

const average = (scores?: Record<string, number>) => {
  const values = Object.values(scores ?? {}).filter(Number.isFinite);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

export function SimpleBench() {
  const [kind, setKind] = useState<EvalKind>("image");
  const [prompt, setPrompt] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [results, setResults] = useState<Record<string, SlotResult>>({});
  const [running, setRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [judge, setJudge] = useState<JudgeConfig>({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  });

  // Load saved keys + judge config once, then rebuild the slot list per mode.
  useEffect(() => {
    const keys = loadSavedKeys();
    const savedJudge = localStorage.getItem(JUDGE_STORE);
    if (savedJudge) {
      try {
        setJudge((current) => ({ ...current, ...(JSON.parse(savedJudge) as JudgeConfig) }));
      } catch {
        /* ignore corrupt storage */
      }
    }
    const [a, b] = defaultKeys("image");
    setSlots([newSlot(a, crypto.randomUUID(), keys), newSlot(b, crypto.randomUUID(), keys)]);
  }, []);

  const switchKind = (next: EvalKind) => {
    if (next === kind) return;
    setKind(next);
    setResults({});
    const keys = loadSavedKeys();
    const [a, b] = defaultKeys(next);
    setSlots([newSlot(a, crypto.randomUUID(), keys), newSlot(b, crypto.randomUUID(), keys)]);
  };

  const persistJudge = (next: JudgeConfig) => {
    setJudge(next);
    localStorage.setItem(JUDGE_STORE, JSON.stringify(next));
  };

  const updateSlot = (id: string, patch: Partial<Slot>) =>
    setSlots((current) => current.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)));

  const changeProvider = (id: string, key: AnyProviderKey) => {
    const def = providerDef(key);
    const keys = loadSavedKeys();
    updateSlot(id, {
      provider: key,
      modelId: def.defaultModel,
      apiKey: keys[key] ?? "",
      baseUrl: ("defaultBaseUrl" in def ? def.defaultBaseUrl : undefined) ?? "",
    });
  };

  const saveKeyFor = (provider: AnyProviderKey, value: string) => {
    saveKey(provider, value);
  };

  const dims = useMemo(() => dimsFor(kind), [kind]);

  const judgeAsset = useCallback(
    async (slotId: string, asset: string, text: string) => {
      setResults((current) => ({
        ...current,
        [slotId]: { ...current[slotId], judging: true, judgeError: undefined },
      }));
      try {
        const res = await fetch("/api/ai-score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: asset,
            kind,
            prompt: text,
            judge: {
              baseUrl: judge.baseUrl,
              apiKey: judge.apiKey || undefined,
              model: judge.model,
            },
          }),
        });
        const data = (await res.json()) as {
          scores?: Record<string, number>;
          reasons?: Record<string, string>;
          summary?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || "AI 打分失败");
        setResults((current) => ({
          ...current,
          [slotId]: {
            ...current[slotId],
            judging: false,
            scores: data.scores,
            reasons: data.reasons,
            summary: data.summary,
          },
        }));
      } catch (error) {
        setResults((current) => ({
          ...current,
          [slotId]: {
            ...current[slotId],
            judging: false,
            judgeError: error instanceof Error ? error.message : "AI 打分失败",
          },
        }));
      }
    },
    [judge, kind],
  );

  const runOne = async (slot: Slot, text: string) => {
    setResults((current) => ({ ...current, [slot.id]: { status: "running" } }));
    const started = performance.now();
    try {
      const endpoint = kind === "image" ? "/api/generate-images" : "/api/generate-videos";
      const payload =
        kind === "image"
          ? {
              prompt: text,
              provider: slot.provider,
              modelId: slot.modelId,
              apiKey: slot.apiKey || undefined,
              baseUrl: slot.baseUrl || undefined,
            }
          : {
              prompt: text,
              provider: slot.provider,
              modelId: slot.modelId,
              apiKey: slot.apiKey || undefined,
              baseUrl: slot.baseUrl || undefined,
              resolution: "720P",
              ratio: "16:9",
              duration: 5,
            };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        image?: string;
        mediaType?: string;
        videoUrl?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "生成失败");

      const asset =
        kind === "image" && data.image
          ? `data:${data.mediaType ?? "image/png"};base64,${data.image}`
          : data.videoUrl;
      if (!asset) throw new Error("接口没有返回素材");

      setResults((current) => ({
        ...current,
        [slot.id]: {
          status: "ok",
          asset,
          mediaType: data.mediaType,
          elapsed: performance.now() - started,
        },
      }));
      await judgeAsset(slot.id, asset, text);
    } catch (error) {
      setResults((current) => ({
        ...current,
        [slot.id]: {
          status: "error",
          elapsed: performance.now() - started,
          error: error instanceof Error ? error.message : "生成失败",
        },
      }));
    }
  };

  const runAll = async () => {
    const text = prompt.trim();
    if (!text) return;
    setRunning(true);
    setResults({});
    await Promise.all(slots.map((slot) => runOne(slot, text)));
    setRunning(false);
  };

  const scoredSlots = slots.filter((slot) => results[slot.id]?.scores);
  const hasOutput = slots.some((slot) => {
    const status = results[slot.id]?.status;
    return status === "ok" || status === "error";
  });

  const exportReport = () => {
    const lines = [
      "# 模型横评报告",
      "",
      `- 类型：${kind === "image" ? "图像生成" : "视频生成"}`,
      `- 提示词：${prompt}`,
      `- 裁判模型：${judge.model}`,
      `- 时间：${new Date().toLocaleString("zh-CN")}`,
      "",
    ];
    if (scoredSlots.length) {
      lines.push(`| 维度 | ${scoredSlots.map((s) => providerDef(s.provider).displayName).join(" | ")} |`);
      lines.push(`| --- | ${scoredSlots.map(() => "---").join(" | ")} |`);
      for (const dim of dims) {
        const row = scoredSlots.map((slot) => results[slot.id]?.scores?.[dim.key] ?? "—");
        lines.push(`| ${dim.label} | ${row.join(" | ")} |`);
      }
      const avgRow = scoredSlots.map((slot) => average(results[slot.id]?.scores).toFixed(2));
      lines.push(`| **平均** | ${avgRow.map((v) => `**${v}**`).join(" | ")} |`);
      lines.push("", "## 评语", "");
      for (const slot of scoredSlots) {
        const result = results[slot.id];
        lines.push(`### ${providerDef(slot.provider).displayName} · ${slot.modelId}`, "");
        if (result.summary) lines.push(`> ${result.summary}`, "");
        for (const dim of dims) {
          const score = result.scores?.[dim.key];
          const reason = result.reasons?.[dim.key];
          if (score !== undefined) {
            lines.push(`- **${dim.label}**：${score}/5${reason ? ` — ${reason}` : ""}`);
          }
        }
        lines.push("");
      }
    } else {
      lines.push("没有可用的评分结果。");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `bench-${Date.now()}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  const providerKeys: AnyProviderKey[] =
    kind === "image" ? (Object.keys(PROVIDERS) as ProviderKey[]) : (Object.keys(VIDEO_PROVIDERS) as VideoProviderKey[]);

  return (
    <main className="min-h-screen bg-[#f5f4ef] text-slate-950">
      <div className="mx-auto max-w-[1400px] space-y-4 p-5">
        {/* ---------------------------------------------------------- header */}
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5" /> 模型横评
          </h1>
          <div className="flex gap-1 rounded-xl bg-black/5 p-1">
            {(["image", "video"] as EvalKind[]).map((value) => (
              <button
                key={value}
                onClick={() => switchKind(value)}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                  kind === value ? "bg-white shadow-sm" : "text-black/50 hover:text-black/70"
                }`}
              >
                {value === "image" ? "图像" : "视频"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setSettingsOpen((open) => !open)}
            className="secondary-button ml-auto"
          >
            <Settings2 className="h-3.5 w-3.5" />
            裁判模型：{judge.model}
          </button>
        </header>

        {settingsOpen && (
          <section className="panel space-y-2">
            <p className="text-xs text-black/50">
              用多模态大模型按 10 个维度打分。填任意 OpenAI 兼容接口即可（OpenAI、阿里百炼、火山方舟、
              中转站都支持）。Key 只存在本机浏览器。
            </p>
            <div className="grid gap-2 md:grid-cols-3">
              <label className="text-xs text-black/50">
                Base URL
                <input
                  className="field mt-1 w-full"
                  value={judge.baseUrl}
                  onChange={(event) => persistJudge({ ...judge, baseUrl: event.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="text-xs text-black/50">
                模型
                <input
                  className="field mt-1 w-full"
                  value={judge.model}
                  onChange={(event) => persistJudge({ ...judge, model: event.target.value })}
                  placeholder="gpt-4o"
                />
              </label>
              <label className="text-xs text-black/50">
                API Key
                <input
                  className="field mt-1 w-full"
                  type="password"
                  value={judge.apiKey}
                  onChange={(event) => persistJudge({ ...judge, apiKey: event.target.value })}
                  placeholder="sk-..."
                />
              </label>
            </div>
          </section>
        )}

        {/* -------------------------------------------------------- composer */}
        <section className="panel">
          <label className="text-xs font-medium text-black/50">提示词</label>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="例：一只橘猫坐在木质桌面上，左边放着一杯红色的咖啡，暖光，浅景深"
            className="field mt-1 w-full resize-y leading-relaxed"
          />

          <div className="mt-3 space-y-2">
            {slots.map((slot) => {
              const def = providerDef(slot.provider);
              const needsBase = "needsBaseUrl" in def && def.needsBaseUrl;
              return (
                <div key={slot.id} className="grid items-center gap-2 md:grid-cols-[1fr_1fr_1.2fr_auto]">
                  <select
                    value={slot.provider}
                    onChange={(event) => changeProvider(slot.id, event.target.value as AnyProviderKey)}
                    className="field"
                  >
                    {providerKeys.map((key) => (
                      <option key={key} value={key}>
                        {providerDef(key).displayName}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field"
                    value={slot.modelId}
                    onChange={(event) => updateSlot(slot.id, { modelId: event.target.value.trim() })}
                    placeholder="模型 ID"
                    list={`models-${slot.id}`}
                  />
                  <datalist id={`models-${slot.id}`}>
                    {(providerDef(slot.provider).models ?? []).map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <input
                    className="field"
                    type="password"
                    value={slot.apiKey}
                    onChange={(event) => {
                      const apiKey = event.target.value;
                      updateSlot(slot.id, { apiKey });
                      saveKeyFor(slot.provider, apiKey);
                    }}
                    placeholder="API Key"
                  />
                  <button
                    onClick={() => setSlots((current) => current.filter((item) => item.id !== slot.id))}
                    disabled={slots.length <= 1}
                    className="tool-button disabled:opacity-30"
                    title="移除这个模型"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  {needsBase && (
                    <input
                      className="field md:col-span-3"
                      value={slot.baseUrl}
                      onChange={(event) => updateSlot(slot.id, { baseUrl: event.target.value })}
                      placeholder="Base URL"
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                setSlots((current) => [
                  ...current,
                  // New slots default to the OpenAI-compatible provider: it is the
                  // one that accepts a custom base URL, which is what most users
                  // need for relay panels and self-hosted gateways.
                  newSlot(
                    providerKeys.includes("custom" as AnyProviderKey)
                      ? ("custom" as AnyProviderKey)
                      : providerKeys[0],
                    crypto.randomUUID(),
                    loadSavedKeys(),
                  ),
                ])
              }
              disabled={slots.length >= MAX_SLOTS}
              className="secondary-button"
            >
              <Plus className="h-3.5 w-3.5" /> 添加模型
            </button>
            <button
              onClick={() => void runAll()}
              disabled={running || !prompt.trim() || slots.length === 0}
              className="primary-button ml-auto"
            >
              {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {running ? "运行中…" : "开始对比"}
            </button>
            {hasOutput && (
              <>
                <button onClick={() => void runAll()} disabled={running} className="secondary-button">
                  <RotateCcw className="h-3.5 w-3.5" /> 重跑
                </button>
                <button onClick={exportReport} className="secondary-button" disabled={!scoredSlots.length}>
                  <Download className="h-3.5 w-3.5" /> 导出报告
                </button>
              </>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------------- results */}
        {hasOutput && (
          <section className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            {slots.map((slot) => {
              const result = results[slot.id];
              const def = providerDef(slot.provider);
              return (
                <article key={slot.id} className="overflow-hidden rounded-2xl border border-black/10 bg-white">
                  <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2 text-xs">
                    <span className="truncate font-medium">{def.displayName}</span>
                    <span className="truncate text-black/35">{slot.modelId}</span>
                    <span className="ml-auto shrink-0 text-black/40">
                      {result?.elapsed ? `${(result.elapsed / 1000).toFixed(1)}s` : ""}
                    </span>
                  </div>
                  <div className="grid min-h-56 place-items-center bg-[#0b0d10]">
                    {result?.status === "running" && (
                      <LoaderCircle className="h-6 w-6 animate-spin text-white/40" />
                    )}
                    {result?.status === "error" && (
                      <p className="p-4 text-center text-xs leading-relaxed text-red-300">{result.error}</p>
                    )}
                    {result?.asset && kind === "image" && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={result.asset} alt={def.displayName} className="max-h-80 w-full object-contain" />
                    )}
                    {result?.asset && kind === "video" && (
                      <video src={result.asset} controls playsInline className="max-h-80 w-full" />
                    )}
                  </div>
                  <div className="space-y-2 p-3">
                    {result?.judging && (
                      <p className="rounded-lg bg-black/[0.03] px-2 py-1.5 text-[11px] text-black/45">
                        AI 评分中…
                      </p>
                    )}
                    {result?.judgeError && (
                      <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700">
                        {result.judgeError}
                      </p>
                    )}
                    {result?.scores && (
                      <>
                        <div className="flex items-baseline gap-1">
                          <span className="text-lg font-semibold">
                            {average(result.scores).toFixed(2)}
                          </span>
                          <span className="text-[11px] text-black/40">
                            / 5 · {scoreWord(average(result.scores))}
                          </span>
                        </div>
                        {result.summary && (
                          <p className="text-[11px] leading-relaxed text-black/55">{result.summary}</p>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {/* ------------------------------------------------------------ table */}
        {scoredSlots.length > 0 && (
          <section className="panel overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-black/10">
                  <th className="py-2 pr-3 text-left font-medium text-black/50">维度</th>
                  {scoredSlots.map((slot) => (
                    <th key={slot.id} className="px-3 py-2 text-left font-medium">
                      <span className="block">{providerDef(slot.provider).displayName}</span>
                      <span className="block text-[10px] font-normal text-black/35">
                        {slot.modelId}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dims.map((dim) => {
                  const row = scoredSlots.map((slot) => results[slot.id]?.scores?.[dim.key]);
                  const best = Math.max(...row.filter((v): v is number => typeof v === "number"), -1);
                  return (
                    <tr key={dim.key} className="border-b border-black/5">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{dim.label}</span>
                        <span className="block text-[10px] text-black/35">{dim.desc}</span>
                      </td>
                      {row.map((value, index) => {
                        const slot = scoredSlots[index];
                        const reason = results[slot.id]?.reasons?.[dim.key];
                        const isBest = typeof value === "number" && value === best && row.length > 1;
                        return (
                          <td key={slot.id} className="px-3 py-2">
                            <span
                              title={reason ?? ""}
                              className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 font-mono ${
                                isBest ? "bg-[#dfffad] font-semibold" : "bg-black/5"
                              }`}
                            >
                              {value ?? "—"}
                            </span>
                            {reason && (
                              <span className="mt-1 block max-w-56 text-[10px] leading-relaxed text-black/40">
                                {reason}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr>
                  <td className="py-2 pr-3 font-medium">平均</td>
                  {scoredSlots.map((slot) => (
                    <td key={slot.id} className="px-3 py-2 font-mono font-semibold">
                      {average(results[slot.id]?.scores).toFixed(2)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[10px] leading-relaxed text-black/35">
              AI 打分存在主观性，同一素材重复评分可能相差约 1 分。维度定义取自 GenEval、T2I-CompBench 与 VBench 的公开口径。
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
