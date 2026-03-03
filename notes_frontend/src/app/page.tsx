"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@/lib/api";
import {
  apiCreateNote,
  apiDeleteNote,
  apiHealthCheck,
  apiListNotes,
  apiListTags,
  apiUpdateNote,
} from "@/lib/api";
import { createLocalNote, loadLocalState, saveLocalState } from "@/lib/storage";
import { renderMarkdownToSafeHtml } from "@/lib/markdown";

type PanelMode = "both" | "editor" | "preview";

function formatShortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function normalizeTag(t: string) {
  return t.trim().replace(/\s+/g, "-").toLowerCase();
}

function uniqueTags(notes: Note[]) {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags ?? []) if (t) set.add(t);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const [tagDraft, setTagDraft] = useState("");
  const [panelMode, setPanelMode] = useState<PanelMode>("both");

  const [status, setStatus] = useState<
    | { kind: "idle"; msg: string }
    | { kind: "saving"; msg: string }
    | { kind: "saved"; msg: string }
    | { kind: "error"; msg: string }
  >({ kind: "idle", msg: "Ready" });

  const lastSavedHashRef = useRef<string>("");

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId]
  );

  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notes
      .filter((n) => (activeTag ? (n.tags ?? []).includes(activeTag) : true))
      .filter((n) => {
        if (!q) return true;
        return (
          n.title.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          (n.tags ?? []).join(" ").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [notes, search, activeTag]);

  const tags = useMemo(() => uniqueTags(notes), [notes]);

  // Load from localStorage first (fast), then try backend (best-effort).
  useEffect(() => {
    const local = loadLocalState();
    if (local?.notes?.length) {
      setNotes(local.notes);
      setSelectedId(local.selectedNoteId ?? local.notes[0]?.id ?? null);
    } else {
      const seed = createLocalNote({
        title: "Welcome to NoteMaster",
        content:
          "# NoteMaster\n\n- Retro three-panel UI\n- **Markdown** editor + preview\n- Autosave (local-first)\n\nTry typing on the right →",
        tags: ["welcome"],
      });
      setNotes([seed]);
      setSelectedId(seed.id);
    }

    (async () => {
      try {
        // quick connectivity ping
        await apiHealthCheck();
        // attempt to hydrate from backend (if implemented)
        const remoteNotes = await apiListNotes().catch(() => null);
        if (remoteNotes && Array.isArray(remoteNotes) && remoteNotes.length) {
          setNotes(remoteNotes);
          setSelectedId((prev) => prev ?? remoteNotes[0]?.id ?? null);
          setStatus({ kind: "saved", msg: "Synced from backend" });
        } else {
          // Tags endpoint best-effort (no-op if missing)
          await apiListTags().catch(() => null);
          setStatus({ kind: "idle", msg: "Offline-first (backend not available)" });
        }
      } catch {
        setStatus({ kind: "idle", msg: "Offline-first (backend not reachable)" });
      }
    })();
  }, []);

  // Persist locally whenever state changes.
  useEffect(() => {
    saveLocalState({ version: 1, notes, selectedNoteId: selectedId });
  }, [notes, selectedId]);

  // Autosave debounce: if selected note changes content/title/tags, persist locally immediately (above)
  // and attempt backend sync best-effort after a short delay.
  useEffect(() => {
    if (!selectedNote) return;

    const hash = JSON.stringify({
      id: selectedNote.id,
      title: selectedNote.title,
      content: selectedNote.content,
      tags: selectedNote.tags,
      updatedAt: selectedNote.updatedAt,
    });

    // if identical to last saved hash, no-op
    if (hash === lastSavedHashRef.current) return;

    setStatus({ kind: "saving", msg: "Autosaving…" });
    const t = window.setTimeout(async () => {
      try {
        // best-effort backend sync:
        // If it's a local id, try create first, else update.
        if (selectedNote.id.startsWith("local_")) {
          const created = await apiCreateNote({
            title: selectedNote.title,
            content: selectedNote.content,
            tags: selectedNote.tags,
          });
          // Replace local note with backend-created note id
          setNotes((prev) =>
            prev.map((n) => (n.id === selectedNote.id ? created : n))
          );
          setSelectedId(created.id);
        } else {
          await apiUpdateNote({
            id: selectedNote.id,
            title: selectedNote.title,
            content: selectedNote.content,
            tags: selectedNote.tags,
          });
        }

        lastSavedHashRef.current = hash;
        setStatus({ kind: "saved", msg: "Saved" });
      } catch {
        // keep local state as source of truth
        lastSavedHashRef.current = hash;
        setStatus({ kind: "error", msg: "Saved locally (sync failed)" });
      }
    }, 700);

    return () => window.clearTimeout(t);
  }, [selectedNote]);

  const [clientSanitizedPreviewHtml, setClientSanitizedPreviewHtml] = useState<string>("");

  const previewHtml = useMemo(() => {
    // During prerender this returns escaped <pre> fallback; after hydration we replace with sanitized HTML.
    return renderMarkdownToSafeHtml(selectedNote?.content ?? "");
  }, [selectedNote?.content]);

  useEffect(() => {
    let cancelled = false;

    async function sanitizeInBrowser() {
      if (typeof window === "undefined") return;
      try {
        const { default: DOMPurify } = await import("dompurify");
        const sanitized = DOMPurify.sanitize(previewHtml, { USE_PROFILES: { html: true } });
        if (!cancelled) setClientSanitizedPreviewHtml(sanitized);
      } catch {
        if (!cancelled) setClientSanitizedPreviewHtml(previewHtml);
      }
    }

    sanitizeInBrowser();

    return () => {
      cancelled = true;
    };
  }, [previewHtml]);

  function updateSelectedNote(patch: Partial<Pick<Note, "title" | "content" | "tags">>) {
    if (!selectedId) return;
    setNotes((prev) =>
      prev.map((n) =>
        n.id === selectedId
          ? {
              ...n,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : n
      )
    );
  }

  async function handleNewNote() {
    const note = createLocalNote({ title: "New Note", content: "", tags: activeTag ? [activeTag] : [] });
    setNotes((prev) => [note, ...prev]);
    setSelectedId(note.id);
    setStatus({ kind: "idle", msg: "New note created (local)" });
  }

  async function handleDeleteSelected() {
    if (!selectedNote) return;
    const id = selectedNote.id;

    // Optimistic local delete
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setSelectedId((prev) => {
      if (prev !== id) return prev;
      const remaining = notes.filter((n) => n.id !== id);
      return remaining[0]?.id ?? null;
    });

    if (!id.startsWith("local_")) {
      try {
        await apiDeleteNote(id);
        setStatus({ kind: "saved", msg: "Deleted" });
      } catch {
        setStatus({ kind: "error", msg: "Deleted locally (sync failed)" });
      }
    } else {
      setStatus({ kind: "saved", msg: "Deleted locally" });
    }
  }

  function handleAddTag() {
    const t = normalizeTag(tagDraft);
    if (!t || !selectedNote) return;
    const next = Array.from(new Set([...(selectedNote.tags ?? []), t]));
    updateSelectedNote({ tags: next });
    setTagDraft("");
  }

  function handleRemoveTag(t: string) {
    if (!selectedNote) return;
    updateSelectedNote({ tags: (selectedNote.tags ?? []).filter((x) => x !== t) });
  }

  // Responsive: on small screens allow toggling panelMode.
  // On larger screens keep "both".
  useEffect(() => {
    const onResize = () => {
      const isSmall = window.matchMedia("(max-width: 1024px)").matches;
      setPanelMode((m) => (isSmall ? m : "both"));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <main className="min-h-screen p-3 md:p-4 lg:p-5">
      <div className="retro-panel retro-scanlines min-h-[calc(100vh-24px)] overflow-hidden">
        <div className="retro-panel-header">
          <div className="flex items-center gap-3 min-w-0">
            <div className="retro-title text-[14px] md:text-[15px] truncate">
              NoteMaster
            </div>
            <div className="hidden md:block retro-subtitle truncate">
              {status.msg}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden lg:inline retro-kbd" aria-label="Keyboard hint">
              Ctrl/Cmd + S autosaves
            </span>
            <button className="retro-btn retro-btn-primary" onClick={handleNewNote}>
              + New
            </button>
            <button
              className="retro-btn retro-btn-danger"
              onClick={handleDeleteSelected}
              disabled={!selectedNote}
              aria-disabled={!selectedNote}
              title="Delete note"
            >
              Delete
            </button>
          </div>
        </div>

        {/* Layout: 3 panels on desktop; stacked on mobile */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_340px_1fr] gap-3 p-3 md:p-4">
          {/* LEFT: tags + search */}
          <section className="retro-panel p-3 md:p-3.5" aria-label="Tags and search">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="retro-title text-[13px]">NAV</div>
              <div className="retro-subtitle">tags & search</div>
            </div>

            <label className="block text-[12px] font-medium text-slate-600 mb-2" htmlFor="search">
              Search
            </label>
            <input
              id="search"
              className="retro-input"
              placeholder="title, content, #tag…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <div className="mt-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="retro-title text-[12px]">TAGS</div>
                <button
                  className="retro-btn"
                  onClick={() => setActiveTag(null)}
                  title="Clear tag filter"
                >
                  Clear
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {tags.length === 0 ? (
                  <div className="retro-subtitle">No tags yet.</div>
                ) : (
                  tags.map((t) => (
                    <button
                      key={t}
                      className={`retro-chip ${activeTag === t ? "retro-chip-active" : ""}`}
                      onClick={() => setActiveTag((prev) => (prev === t ? null : t))}
                      aria-pressed={activeTag === t}
                      title={`Filter by ${t}`}
                    >
                      <span className="text-slate-500">#</span>
                      <span>{t}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Mobile helper: panel toggles */}
            <div className="mt-5 lg:hidden">
              <div className="retro-title text-[12px] mb-2">VIEW</div>
              <div className="flex gap-2">
                <button
                  className={`retro-btn ${panelMode === "editor" ? "retro-btn-primary" : ""}`}
                  onClick={() => setPanelMode("editor")}
                >
                  Editor
                </button>
                <button
                  className={`retro-btn ${panelMode === "preview" ? "retro-btn-primary" : ""}`}
                  onClick={() => setPanelMode("preview")}
                >
                  Preview
                </button>
                <button
                  className={`retro-btn ${panelMode === "both" ? "retro-btn-primary" : ""}`}
                  onClick={() => setPanelMode("both")}
                >
                  Both
                </button>
              </div>
            </div>

            <div className="mt-4 text-[12px] text-slate-600">
              <div className="retro-title text-[12px] mb-1">SYNC</div>
              <div className="retro-subtitle">
                Backend URL:{" "}
                <span className="font-mono text-[11px] break-all">
                  {process.env.NEXT_PUBLIC_NOTES_API_BASE_URL ??
                    "vscode-internal…:3001 (default)"}
                </span>
              </div>
              <div className="retro-subtitle mt-1">
                If backend endpoints are missing, the app stays fully local.
              </div>
            </div>
          </section>

          {/* CENTER: list */}
          <section className="retro-panel p-3 md:p-3.5" aria-label="Notes list">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="retro-title text-[13px]">NOTES</div>
              <div className="retro-subtitle">{filteredNotes.length} shown</div>
            </div>

            <div className="max-h-[55vh] lg:max-h-[calc(100vh-180px)] overflow-auto pr-1">
              <ul className="space-y-2">
                {filteredNotes.map((n) => {
                  const active = n.id === selectedId;
                  return (
                    <li key={n.id}>
                      <button
                        className={`w-full text-left rounded-[12px] border px-3 py-2 transition ${
                          active
                            ? "border-cyan-400/60 bg-cyan-50"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                        onClick={() => setSelectedId(n.id)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono font-bold text-[13px] truncate">
                              {n.title || "Untitled"}
                            </div>
                            <div className="text-[12px] text-slate-600 truncate">
                              {n.content?.trim()
                                ? n.content.trim().split("\n")[0]
                                : "—"}
                            </div>
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono whitespace-nowrap">
                            {formatShortDate(n.updatedAt)}
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(n.tags ?? []).slice(0, 4).map((t) => (
                            <span key={t} className="retro-chip py-1 px-2 text-[11px]">
                              <span className="text-slate-500">#</span>
                              {t}
                            </span>
                          ))}
                          {(n.tags ?? []).length > 4 ? (
                            <span className="retro-subtitle">+{(n.tags ?? []).length - 4}</span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* RIGHT: editor + preview */}
          <section className="retro-panel p-3 md:p-3.5" aria-label="Editor and preview">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="retro-title text-[13px]">EDITOR</div>
              <div
                className={`text-[12px] font-mono ${
                  status.kind === "error"
                    ? "text-red-600"
                    : status.kind === "saving"
                      ? "text-slate-600"
                      : "text-slate-600"
                }`}
                aria-live="polite"
              >
                {status.msg}
              </div>
            </div>

            {!selectedNote ? (
              <div className="retro-subtitle">Select a note to begin.</div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-medium text-slate-600 mb-2" htmlFor="title">
                    Title
                  </label>
                  <input
                    id="title"
                    className="retro-input"
                    value={selectedNote.title}
                    onChange={(e) => updateSelectedNote({ title: e.target.value })}
                    placeholder="Untitled"
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-slate-600 mb-2" htmlFor="tagDraft">
                    Tags
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="tagDraft"
                      className="retro-input"
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      placeholder="add tag (press Enter)"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                    />
                    <button className="retro-btn" onClick={handleAddTag}>
                      Add
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {(selectedNote.tags ?? []).length === 0 ? (
                      <div className="retro-subtitle">No tags.</div>
                    ) : (
                      (selectedNote.tags ?? []).map((t) => (
                        <span key={t} className="retro-chip">
                          <span className="text-slate-500">#</span>
                          <span>{t}</span>
                          <button
                            className="ml-1 text-slate-500 hover:text-slate-800"
                            onClick={() => handleRemoveTag(t)}
                            aria-label={`Remove tag ${t}`}
                            title="Remove tag"
                          >
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {(panelMode === "both" || panelMode === "editor") && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="retro-title text-[12px]">MARKDOWN</div>
                        <div className="retro-subtitle">autosaves locally</div>
                      </div>
                      <textarea
                        className="retro-textarea"
                        value={selectedNote.content}
                        onChange={(e) => updateSelectedNote({ content: e.target.value })}
                        placeholder="Write markdown here…"
                      />
                    </div>
                  )}

                  {(panelMode === "both" || panelMode === "preview") && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="retro-title text-[12px]">PREVIEW</div>
                        <div className="retro-subtitle">sanitized HTML</div>
                      </div>
                      <div
                        className="retro-panel p-3 overflow-auto max-h-[420px] xl:max-h-[520px]"
                        aria-label="Markdown preview"
                      >
                        <div
                          className="md"
                          dangerouslySetInnerHTML={{
                            __html: clientSanitizedPreviewHtml || previewHtml,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="retro-subtitle">
                  Last updated:{" "}
                  <span className="font-mono">{formatShortDate(selectedNote.updatedAt)}</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
