/**
 * Personal prompt library - the thing the built-in question bank cannot do.
 *
 * The upstream workbench ships 42 image prompts and 18 video prompts, both
 * fixed. Whatever you actually type never survives the session. This store
 * keeps it: every prompt you save is reusable, searchable, exportable, and
 * survives a restart because it lives in IndexedDB rather than component state.
 */
import { PROMPT_STORE, transact } from "./db";

export type PromptKind = "image" | "video";

export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  kind: PromptKind;
  tags: string[];
  note?: string;
  createdAt: string;
  usedAt?: string;
  useCount: number;
}

const now = () => new Date().toISOString();

/** Derive a short label from the prompt body: first sentence, capped. */
export const deriveTitle = (prompt: string, max = 26) => {
  const first = prompt.trim().split(/[。！？.!?\n]/)[0]?.trim() ?? "";
  const base = first || prompt.trim();
  return base.length > max ? `${base.slice(0, max)}…` : base;
};

const list = () =>
  transact<SavedPrompt[]>(PROMPT_STORE, "readonly", (store) => store.getAll());

export const listPrompts = async (kind?: PromptKind) => {
  const all = await list();
  const filtered = kind ? all.filter((item) => item.kind === kind) : all;
  return filtered.sort((a, b) => (b.usedAt ?? b.createdAt).localeCompare(a.usedAt ?? a.createdAt));
};

export interface SavePromptInput {
  prompt: string;
  kind: PromptKind;
  title?: string;
  tags?: string[];
  note?: string;
}

/**
 * Saving the same text twice is a no-op that reports the existing entry, rather
 * than creating duplicates - users routinely re-save after tweaking the title.
 * The `created` flag lets the caller word the confirmation correctly.
 */
export const savePrompt = async (
  input: SavePromptInput,
): Promise<{ entry: SavedPrompt; created: boolean }> => {
  const text = input.prompt.trim();
  if (!text) throw new Error("提示词为空");

  const existing = (await list()).find((item) => item.prompt.trim() === text);
  if (existing) {
    const merged: SavedPrompt = {
      ...existing,
      title: input.title?.trim() || existing.title,
      tags: input.tags?.length ? input.tags : existing.tags,
      note: input.note ?? existing.note,
    };
    await transact(PROMPT_STORE, "readwrite", (store) => store.put(merged));
    return { entry: merged, created: false };
  }

  const entry: SavedPrompt = {
    id: crypto.randomUUID(),
    title: input.title?.trim() || deriveTitle(text),
    prompt: text,
    kind: input.kind,
    tags: input.tags ?? [],
    note: input.note,
    createdAt: now(),
    useCount: 0,
  };
  await transact(PROMPT_STORE, "readwrite", (store) => store.put(entry));
  return { entry, created: true };
};

export const deletePrompt = (id: string) =>
  transact(PROMPT_STORE, "readwrite", (store) => store.delete(id));

export const updatePrompt = async (
  id: string,
  patch: Partial<Pick<SavedPrompt, "title" | "tags" | "note">>,
) => {
  const all = await list();
  const target = all.find((item) => item.id === id);
  if (!target) return null;
  const next = { ...target, ...patch };
  await transact(PROMPT_STORE, "readwrite", (store) => store.put(next));
  return next;
};

/** Called when a prompt is loaded into the editor, so recency ordering works. */
export const touchPrompt = async (id: string) => {
  const all = await list();
  const target = all.find((item) => item.id === id);
  if (!target) return null;
  const next: SavedPrompt = {
    ...target,
    usedAt: now(),
    useCount: target.useCount + 1,
  };
  await transact(PROMPT_STORE, "readwrite", (store) => store.put(next));
  return next;
};

export const clearPrompts = () =>
  transact(PROMPT_STORE, "readwrite", (store) => store.clear());

// ------------------------------------------------------------------- transfer

export const exportPrompts = async (): Promise<string> => {
  const all = await list();
  return JSON.stringify(
    { format: "visual-eval-prompts", version: 1, exportedAt: now(), prompts: all },
    null,
    2,
  );
};

/**
 * Merge-import: entries whose text already exists are skipped, so importing the
 * same file twice does not double the library. Returns how many were added.
 */
export const importPrompts = async (raw: string): Promise<number> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("不是合法的 JSON");
  }
  const payload = parsed as { prompts?: unknown };
  const incoming = Array.isArray(payload?.prompts)
    ? (payload.prompts as Partial<SavedPrompt>[])
    : Array.isArray(parsed)
      ? (parsed as Partial<SavedPrompt>[])
      : null;
  if (!incoming) throw new Error("找不到 prompts 数组");

  const existing = new Set((await list()).map((item) => item.prompt.trim()));
  let added = 0;
  for (const item of incoming) {
    const text = typeof item.prompt === "string" ? item.prompt.trim() : "";
    if (!text || existing.has(text)) continue;
    const entry: SavedPrompt = {
      id: crypto.randomUUID(),
      title: item.title?.trim() || deriveTitle(text),
      prompt: text,
      kind: item.kind === "video" ? "video" : "image",
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string") : [],
      note: typeof item.note === "string" ? item.note : undefined,
      createdAt: item.createdAt ?? now(),
      useCount: typeof item.useCount === "number" ? item.useCount : 0,
    };
    await transact(PROMPT_STORE, "readwrite", (store) => store.put(entry));
    existing.add(text);
    added += 1;
  }
  return added;
};
