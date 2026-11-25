"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  BookMarked,
  Download,
  PencilLine,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  deletePrompt,
  exportPrompts,
  importPrompts,
  listPrompts,
  PromptKind,
  SavedPrompt,
  savePrompt,
  touchPrompt,
  updatePrompt,
} from "@/lib/prompt-library";

interface PromptLibraryProps {
  kind: PromptKind;
  currentPrompt: string;
  onLoad: (prompt: string) => void;
  /** Bumped by the parent when the prompt changes elsewhere, to re-enable saving. */
  refreshKey?: number;
}

export function PromptLibrary({
  kind,
  currentPrompt,
  onLoad,
  refreshKey = 0,
}: PromptLibraryProps) {
  const [items, setItems] = useState<SavedPrompt[]>([]);
  const [query, setQuery] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (message: string) => {
    setHint(message);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(""), 2600);
  };

  const refresh = async () => {
    try {
      setItems(await listPrompts(kind));
    } catch {
      flash("读取本地提示词库失败");
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.prompt.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [items, query]);

  const handleSave = async () => {
    const text = currentPrompt.trim();
    if (!text) return;
    setBusy(true);
    try {
      const { created } = await savePrompt({ prompt: text, kind });
      await refresh();
      flash(created ? "已收藏到本地库" : "这条已在库中，已更新");
    } catch (error) {
      flash(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLoad = async (item: SavedPrompt) => {
    onLoad(item.prompt);
    try {
      await touchPrompt(item.id);
      setItems(await listPrompts(kind));
    } catch {
      /* recency bookkeeping is best-effort */
    }
  };

  const handleRename = async (item: SavedPrompt) => {
    const next = window.prompt("重命名这条提示词", item.title);
    if (next === null) return;
    const title = next.trim();
    if (!title) return;
    await updatePrompt(item.id, { title });
    await refresh();
  };

  const handleDelete = async (item: SavedPrompt) => {
    if (!window.confirm(`删除「${item.title}」？此操作不可撤销。`)) return;
    await deletePrompt(item.id);
    await refresh();
    flash("已删除");
  };

  const handleExport = async () => {
    const raw = await exportPrompts();
    const blob = new Blob([raw], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `prompts-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  const handleImport = async (file: File) => {
    setBusy(true);
    try {
      const added = await importPrompts(await file.text());
      await refresh();
      flash(added ? `导入 ${added} 条` : "没有新增（全部已存在）");
    } catch (error) {
      flash(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <section className="panel">
      <div className="mb-3 flex items-center gap-2 font-semibold">
        <BookMarked className="h-4 w-4" /> 我的提示词
        <span className="ml-auto text-xs font-normal text-black/40">
          {items.length} 条
        </span>
      </div>

      <button
        onClick={handleSave}
        disabled={busy || !currentPrompt.trim()}
        className="secondary-button mb-2 w-full"
        title="把当前输入框里的提示词存到本地库，下次可直接复用"
      >
        <BookmarkPlus className="h-3.5 w-3.5" />
        {currentPrompt.trim() ? "收藏当前提示词" : "输入框为空"}
      </button>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-black/30" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索提示词或标签"
          className="field w-full pl-8"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-2 top-2 rounded p-1 text-black/30 hover:bg-black/5"
            title="清空搜索"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
        {filtered.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-black/35">
            {items.length === 0
              ? "还没有收藏的提示词。写一条满意的，点上面的「收藏当前提示词」。"
              : "没有匹配的结果。"}
          </p>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="group rounded-lg border border-black/5 bg-[#fafaf7] p-2 transition hover:border-black/15"
            >
              <button
                onClick={() => void handleLoad(item)}
                className="w-full text-left"
                title="载入这条提示词"
              >
                <div className="truncate text-xs font-medium">{item.title}</div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-black/45">
                  {item.prompt}
                </div>
              </button>
              <div className="mt-1 flex items-center gap-1">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-black/50"
                  >
                    {tag}
                  </span>
                ))}
                <span className="ml-auto text-[10px] text-black/30">
                  {item.useCount > 0 ? `用 ${item.useCount} 次` : "未用"}
                </span>
                <button
                  onClick={() => void handleRename(item)}
                  className="rounded p-1 text-black/30 hover:bg-black/5 hover:text-black/60"
                  title="重命名"
                >
                  <PencilLine className="h-3 w-3" />
                </button>
                <button
                  onClick={() => void handleDelete(item)}
                  className="rounded p-1 text-black/30 hover:bg-red-50 hover:text-red-500"
                  title="删除"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-2 flex gap-1">
        <button
          onClick={() => void handleExport()}
          disabled={busy || items.length === 0}
          className="secondary-button flex-1"
          title="导出全部提示词为 JSON"
        >
          <Download className="h-3 w-3" /> 导出
        </button>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="secondary-button flex-1"
          title="从 JSON 导入，重复的会自动跳过"
        >
          <Upload className="h-3 w-3" /> 导入
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImport(file);
          }}
        />
      </div>

      {hint && (
        <p className="mt-2 rounded-lg bg-[#eef4e4] px-2 py-1.5 text-[11px] text-[#4a6b1f]">
          {hint}
        </p>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-black/30">
        存在本机浏览器（IndexedDB），不上传服务器。换机器请用导出/导入。
      </p>
    </section>
  );
}
