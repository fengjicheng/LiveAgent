import { DiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import {
  BrushCleaning,
  Eye,
  FilePenLine,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/shared/utils";
import type {
  GitClient,
  GitDiffResponse,
  GitRepositoryState,
  GitStatusEntry,
} from "../../lib/git/types";
import { emptyGitRepositoryState } from "../../lib/git/types";
import { getFileTypeIcon } from "../chat/fileTypeIcons";

const LARGE_DIFF_CHUNK_CHAR_LIMIT = 120 * 1024;
const LARGE_DIFF_CHUNK_LINE_LIMIT = 1800;
const RAW_DIFF_PREVIEW_CHAR_LIMIT = 60 * 1024;
const INITIAL_CHANGE_ENTRY_RENDER_COUNT = 160;
const CHANGE_ENTRY_RENDER_BATCH_SIZE = 160;

type PatchChunk = {
  key: string;
  label: string;
  chunk: string;
  lineCount: number;
  large: boolean;
};

type DiffStatFile = {
  key: string;
  path: string;
  changes: number | null;
  additions: number;
  deletions: number;
  additionPercent: number;
  deletionPercent: number;
  binary: boolean;
  raw: string;
};

type DiffStatSummary = {
  raw?: string;
};

type ParsedDiffStat = {
  files: DiffStatFile[];
  fallbackLines: string[];
  summary: DiffStatSummary;
};

type DiffViewKind = "branch" | "workingTree";

type ChangeContextMenuState = {
  x: number;
  y: number;
  path: string;
};

type ChangesMenuState = {
  x: number;
  y: number;
};

const CHANGE_CONTEXT_MENU_WIDTH = 232;
const CHANGE_CONTEXT_MENU_HEIGHT = 210;
const CHANGES_MENU_WIDTH = 232;
const CHANGES_MENU_HEIGHT = 170;
const CHANGE_CONTEXT_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45";

function useIsDark() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function splitPatchByFile(patch: string) {
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((line) => line.trim() !== "")) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

function cleanDiffPath(value: string) {
  if (!value || value === "/dev/null") return "";
  return value.replace(/^[ab]\//, "");
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized || "Untitled";
}

function parentPath(path: string) {
  return dirname(path) || ".";
}

function getPatchFileNames(chunk: string, fallback: string) {
  const lines = chunk.split("\n");
  const gitHeader = lines.find((line) => line.startsWith("diff --git "));
  if (gitHeader) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(gitHeader);
    if (match) {
      return {
        oldFileName: cleanDiffPath(match[1] ?? "") || fallback,
        newFileName: cleanDiffPath(match[2] ?? "") || fallback,
      };
    }
  }
  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  return {
    oldFileName: cleanDiffPath(oldHeader?.slice(4).trim() ?? "") || fallback,
    newFileName: cleanDiffPath(newHeader?.slice(4).trim() ?? "") || fallback,
  };
}

function countLines(value: string) {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function parseDiffStatFile(line: string, index: number): DiffStatFile | null {
  const pipeIndex = line.lastIndexOf("|");
  if (pipeIndex < 0) return null;
  const path = line.slice(0, pipeIndex).trim();
  const details = line.slice(pipeIndex + 1).trim();
  if (!path || !details) return null;

  const binary = /^Bin\b/.test(details);
  if (binary) {
    return {
      key: `${path}:${index}`,
      path,
      changes: null,
      additions: 0,
      deletions: 0,
      additionPercent: 0,
      deletionPercent: 0,
      binary: true,
      raw: line,
    };
  }

  const match = /^(\d+)\s*([+\-]*)/.exec(details);
  if (!match?.[1]) return null;
  const changes = Number(match[1]);
  if (!Number.isFinite(changes)) return null;
  const graph = match[2] ?? "";
  const graphAdditions = graph.split("").filter((char) => char === "+").length;
  const graphDeletions = graph.split("").filter((char) => char === "-").length;
  const graphUnits = graphAdditions + graphDeletions;
  const additions = graphUnits > 0 ? Math.round(changes * (graphAdditions / graphUnits)) : 0;
  const deletions = graphUnits > 0 ? Math.max(0, changes - additions) : 0;
  const total = additions + deletions;
  const additionPercent = total > 0 ? (additions / total) * 100 : 0;
  const deletionPercent = total > 0 ? (deletions / total) * 100 : 0;

  return {
    key: `${path}:${index}`,
    path,
    changes,
    additions,
    deletions,
    additionPercent,
    deletionPercent,
    binary: false,
    raw: line,
  };
}

function parseDiffStat(stat: string): ParsedDiffStat {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const hasSummary =
    /\bfiles? changed\b/.test(lastLine) ||
    /\binsertions?\(\+\)/.test(lastLine) ||
    /\bdeletions?\(-\)/.test(lastLine);
  const summary: DiffStatSummary = hasSummary
    ? {
        raw: lastLine,
      }
    : {};
  const fileLines = hasSummary ? lines.slice(0, -1) : lines;
  const files: DiffStatFile[] = [];
  const fallbackLines: string[] = [];
  fileLines.forEach((line, index) => {
    const file = parseDiffStatFile(line, index);
    if (file) {
      files.push(file);
    } else {
      fallbackLines.push(line);
    }
  });
  return { files, fallbackLines, summary };
}

function buildPatchChunks(patch: string, title: string): PatchChunk[] {
  if (!patch.trim()) return [];
  return splitPatchByFile(patch).map((chunk, index) => {
    const names = getPatchFileNames(chunk, `${title}-${index + 1}`);
    const label = names.newFileName || names.oldFileName || `${title} ${index + 1}`;
    const lineCount = countLines(chunk);
    return {
      key: `${names.oldFileName}:${names.newFileName}:${index}`,
      label,
      chunk,
      lineCount,
      large:
        chunk.length > LARGE_DIFF_CHUNK_CHAR_LIMIT ||
        lineCount > LARGE_DIFF_CHUNK_LINE_LIMIT,
    };
  });
}

const DiffChunkView = memo(function DiffChunkView(props: {
  item: PatchChunk;
  isDark: boolean;
}) {
  const { item, isDark } = props;
  const { t } = useLocale();
  const diffFile = useMemo(() => {
    if (item.large) return null;
    try {
      const names = getPatchFileNames(item.chunk, item.label);
      const instance = new DiffFile(
        names.oldFileName,
        "",
        names.newFileName,
        "",
        [item.chunk],
        "diff",
        "diff",
      );
      instance.initTheme(isDark ? "dark" : "light");
      instance.init();
      instance.buildUnifiedDiffLines();
      return instance;
    } catch {
      return null;
    }
  }, [isDark, item]);

  const rawPreview = useMemo(() => {
    if (!item.large) return item.chunk;
    return item.chunk.length > RAW_DIFF_PREVIEW_CHAR_LIMIT
      ? `${item.chunk.slice(0, RAW_DIFF_PREVIEW_CHAR_LIMIT)}\n\n${t("projectTools.gitReview.diffPreviewTruncated")}`
      : item.chunk;
  }, [item, t]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.large ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {t("projectTools.gitReview.largeDiff")}
          </span>
        ) : null}
      </div>
      {diffFile ? (
        <DiffView
          diffFile={diffFile}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap={false}
          diffViewFontSize={12}
        />
      ) : (
        <pre className="max-h-[26rem] overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {rawPreview}
        </pre>
      )}
    </div>
  );
});

function DiffStatView(props: { stat: string }) {
  const { stat } = props;
  const { t } = useLocale();
  const parsed = useMemo(() => parseDiffStat(stat), [stat]);
  if (!stat.trim()) return null;

  const showStructured = parsed.files.length > 0;

  if (!showStructured) {
    return (
      <pre className="max-h-24 overflow-auto border-b border-border/70 bg-muted/25 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {stat}
      </pre>
    );
  }

  return (
    <div className="border-b border-border/70 bg-muted/10 px-3 py-2">
      {parsed.files.length > 0 ? (
        <div className="max-h-40 overflow-auto space-y-1">
          {parsed.files.map((file) => (
            <div
              key={file.key}
              className="rounded-md border border-border/60 bg-background/75 px-2.5 py-2"
              title={file.raw}
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                  {basename(file.path)}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                  {file.binary ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {t("projectTools.gitReview.statBinary")}
                    </span>
                  ) : (
                    <>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {file.changes} {t("projectTools.gitReview.statChanges")}
                      </span>
                      {file.additions > 0 ? (
                        <span
                          className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300"
                          title={t("projectTools.gitReview.statInsertions")}
                        >
                          +{file.additions}
                        </span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span
                          className="rounded-full bg-rose-500/10 px-1.5 py-0.5 font-semibold text-rose-700 dark:text-rose-300"
                          title={t("projectTools.gitReview.statDeletions")}
                        >
                          -{file.deletions}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
                  {file.additions > 0 ? (
                    <span
                      className="h-full bg-emerald-500/75"
                      style={{ width: `${file.additionPercent}%` }}
                    />
                  ) : null}
                  {file.deletions > 0 ? (
                    <span
                      className="h-full bg-rose-500/75"
                      style={{ width: `${file.deletionPercent}%` }}
                    />
                  ) : null}
                  {!file.binary && file.additions + file.deletions === 0 ? (
                    <span className="h-full w-full bg-muted-foreground/25" />
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.fallbackLines.length > 0 ? (
        <pre className="mt-2 max-h-20 overflow-auto rounded-md bg-muted/35 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {parsed.fallbackLines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

function DiffContent(props: { diff?: GitDiffResponse | null; title: string; error?: string }) {
  const { diff, title, error } = props;
  const { t } = useLocale();
  const isDark = useIsDark();
  const patchChunks = useMemo(
    () => buildPatchChunks(diff?.patch ?? "", title),
    [diff?.patch, title],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {error ? <div className="shrink-0 px-3 py-3 text-xs text-destructive">{error}</div> : null}
      {!error && diff?.stat ? (
        <DiffStatView stat={diff.stat} />
      ) : null}
      {!error && patchChunks.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {patchChunks.map((item) => (
            <DiffChunkView key={item.key} item={item} isDark={isDark} />
          ))}
        </div>
      ) : null}
      {!error && diff?.patch.trim() && patchChunks.length === 0 ? (
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {diff.patch}
        </pre>
      ) : null}
      {!error && !diff?.patch.trim() && patchChunks.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8 text-center text-xs text-muted-foreground">
          {t("projectTools.gitReview.noDiff")}
        </div>
      ) : null}
      {diff?.truncated ? (
        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
          {t("projectTools.gitReview.diffOutputTruncated")}
        </div>
      ) : null}
    </div>
  );
}

function DiffReviewCard(props: {
  activeView: DiffViewKind;
  branchDiff?: GitDiffResponse | null;
  branchError?: string;
  diffLoading?: boolean;
  onActiveViewChange: (view: DiffViewKind) => void;
  worktreeDiff?: GitDiffResponse | null;
}) {
  const {
    activeView,
    branchDiff,
    branchError,
    diffLoading,
    onActiveViewChange,
    worktreeDiff,
  } = props;
  const { t } = useLocale();
  const activeDiff = activeView === "branch" ? branchDiff : worktreeDiff;
  const branchTitle = t("projectTools.gitReview.branchDiff");
  const workingTreeTitle = t("projectTools.gitReview.workingTree");
  const activeTitle = activeView === "branch" ? branchTitle : workingTreeTitle;
  const activeError = activeView === "branch" ? branchError : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{activeTitle}</div>
          {activeDiff ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {activeDiff.baseRef} → {activeDiff.headRef}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diffLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <Button
            type="button"
            size="sm"
            variant={activeView === "workingTree" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={workingTreeTitle}
            aria-label={t("projectTools.gitReview.showWorkingTree")}
            onClick={() => onActiveViewChange("workingTree")}
          >
            <FolderTree className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeView === "branch" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={branchTitle}
            aria-label={t("projectTools.gitReview.showBranchDiff")}
            onClick={() => onActiveViewChange("branch")}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <DiffContent title={activeTitle} diff={activeDiff} error={activeError} />
    </section>
  );
}

function statusTone(entry: GitStatusEntry) {
  if (entry.conflicted) return "text-destructive";
  if (entry.untracked) return "text-sky-600 dark:text-sky-300";
  if (entry.staged) return "text-emerald-600 dark:text-emerald-300";
  return "text-amber-600 dark:text-amber-300";
}

function statusLabel(entry: GitStatusEntry) {
  if (entry.conflicted) return "U";
  if (entry.untracked) return "U";
  const statuses = [entry.indexStatus, entry.worktreeStatus].filter((status) => status && status !== ".");
  if (entry.kind === "renamed" || statuses.includes("R")) return "R";
  if (statuses.includes("D")) return "D";
  if (statuses.includes("A")) return "A";
  if (statuses.includes("M") || statuses.includes("T")) return "M";
  return statuses[0] ?? "";
}

function canStageEntry(entry: GitStatusEntry) {
  return entry.untracked || entry.conflicted || entry.worktreeStatus !== ".";
}

function revealTargetForEntry(entry: GitStatusEntry) {
  if (!entry.untracked && (entry.indexStatus === "D" || entry.worktreeStatus === "D")) {
    return dirname(entry.oldPath ?? entry.path);
  }
  return entry.path;
}

function assertGitOperationResult(value: unknown, fallbackMessage: string) {
  if (!value || typeof value !== "object") return;
  const result = value as { ok?: unknown; message?: unknown; stderr?: unknown };
  if (result.ok === false) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message
        : typeof result.stderr === "string" && result.stderr.trim()
          ? result.stderr
          : fallbackMessage;
    throw new Error(message);
  }
}

export function GitReviewPanel(props: {
  cwd: string;
  gitClient?: GitClient | null;
  canWrite?: boolean;
  disabledMessage?: string;
  onRevealInFileTree?: (path: string) => void;
}) {
  const { cwd, gitClient, canWrite = true, disabledMessage, onRevealInFileTree } = props;
  const { t } = useLocale();
  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(cwd));
  const [branchDiff, setBranchDiff] = useState<GitDiffResponse | null>(null);
  const [worktreeDiff, setWorktreeDiff] = useState<GitDiffResponse | null>(null);
  const [branchError, setBranchError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [activeDiffView, setActiveDiffView] = useState<DiffViewKind>("workingTree");
  const [changeContextMenu, setChangeContextMenu] = useState<ChangeContextMenuState | null>(null);
  const [changesMenu, setChangesMenu] = useState<ChangesMenuState | null>(null);
  const selectedPathRef = useRef("");
  const diffRequestIdRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const suppressNextGitChangedRef = useRef(false);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const clearDiffs = useCallback(() => {
    diffRequestIdRef.current += 1;
    setBranchDiff(null);
    setWorktreeDiff(null);
    setBranchError("");
    setDiffLoading(false);
  }, []);

  const loadDiffForPath = useCallback(
    async (path: string) => {
      const cleanPath = path.trim();
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      setBranchError("");
      setError("");
      if (!gitClient || !cwd.trim() || !cleanPath) {
        clearDiffs();
        return;
      }
      setDiffLoading(true);
      try {
        const [branchResult, worktreeResult] = await Promise.allSettled([
          gitClient.diff(cwd, "branch", cleanPath),
          gitClient.diff(cwd, "working_tree", cleanPath),
        ]);
        if (diffRequestIdRef.current !== requestId) return;
        if (branchResult.status === "fulfilled") {
          setBranchDiff(branchResult.value);
        } else {
          setBranchDiff(null);
          setBranchError(branchResult.reason instanceof Error ? branchResult.reason.message : String(branchResult.reason));
        }
        if (worktreeResult.status === "fulfilled") {
          setWorktreeDiff(worktreeResult.value);
        } else {
          setWorktreeDiff(null);
          setError(worktreeResult.reason instanceof Error ? worktreeResult.reason.message : String(worktreeResult.reason));
        }
      } catch (err) {
        if (diffRequestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (diffRequestIdRef.current === requestId) {
          setDiffLoading(false);
        }
      }
    },
    [clearDiffs, cwd, gitClient],
  );

  const refresh = useCallback(async () => {
    if (!gitClient || !cwd.trim()) {
      setState(emptyGitRepositoryState(cwd));
      setSelectedPath("");
      clearDiffs();
      return;
    }
    setLoading(true);
    setError("");
    setBranchError("");
    try {
      const nextState = await gitClient.status(cwd);
      setState(nextState);
      if (nextState.status !== "ready") {
        setSelectedPath("");
        clearDiffs();
        return;
      }
      const currentPath = selectedPathRef.current;
      const nextPath = nextState.entries.some((entry) => entry.path === currentPath)
        ? currentPath
        : nextState.entries[0]?.path ?? "";
      selectedPathRef.current = nextPath;
      setSelectedPath(nextPath);
      if (nextPath) {
        void loadDiffForPath(nextPath);
      } else {
        clearDiffs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [clearDiffs, cwd, gitClient, loadDiffForPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleGitChanged = () => {
      if (suppressNextGitChangedRef.current) {
        suppressNextGitChangedRef.current = false;
        return;
      }
      void refresh();
    };
    window.addEventListener("liveagent:git-changed", handleGitChanged);
    return () => window.removeEventListener("liveagent:git-changed", handleGitChanged);
  }, [refresh]);

  const runOperation = useCallback(
    async (name: string, task: () => Promise<unknown>) => {
      if (!gitClient || !cwd.trim() || !canWrite) return;
      setBusy(name);
      setError("");
      try {
        const result = await task();
        assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
        await refresh();
        suppressNextGitChangedRef.current = true;
        window.dispatchEvent(new Event("liveagent:git-changed"));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy("");
      }
    },
    [canWrite, cwd, gitClient, refresh, t],
  );

  const entries = state.entries;
  const [visibleEntryCount, setVisibleEntryCount] = useState(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  useEffect(() => {
    setVisibleEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  }, [state.repoRoot, state.head, entries.length]);
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleEntryCount),
    [entries, visibleEntryCount],
  );
  const hiddenEntryCount = Math.max(0, entries.length - visibleEntries.length);
  const writeDisabled = !canWrite || Boolean(disabledMessage) || state.status !== "ready";
  const hasStageableChanges = state.dirtyCounts.unstaged > 0 || state.dirtyCounts.untracked > 0;
  const hasStagedChanges = state.dirtyCounts.staged > 0;
  const hasDiscardableChanges = entries.length > 0;
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );
  const contextEntry = useMemo(
    () => entries.find((entry) => entry.path === changeContextMenu?.path) ?? null,
    [changeContextMenu?.path, entries],
  );
  const contextEntryCanStage = contextEntry ? canStageEntry(contextEntry) : false;

  useEffect(() => {
    if (!changeContextMenu) return;
    const closeMenu = () => setChangeContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changeContextMenu]);

  useEffect(() => {
    if (!changesMenu) return;
    const closeMenu = () => setChangesMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changesMenu]);

  const selectEntry = useCallback(
    (entry: GitStatusEntry) => {
      selectedPathRef.current = entry.path;
      setSelectedPath(entry.path);
      void loadDiffForPath(entry.path);
    },
    [loadDiffForPath],
  );

  const openChangeContextMenu = useCallback(
    (event: ReactMouseEvent, entry: GitStatusEntry) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      const panelRect = panelRef.current?.getBoundingClientRect();
      const left = panelRect ? event.clientX - panelRect.left : event.clientX;
      const top = panelRect ? event.clientY - panelRect.top : event.clientY;
      const maxLeft = Math.max(8, (panelRect?.width ?? window.innerWidth) - CHANGE_CONTEXT_MENU_WIDTH - 8);
      const maxTop = Math.max(8, (panelRect?.height ?? window.innerHeight) - CHANGE_CONTEXT_MENU_HEIGHT - 8);
      setChangeContextMenu({
        x: Math.max(8, Math.min(left, maxLeft)),
        y: Math.max(8, Math.min(top, maxTop)),
        path: entry.path,
      });
    },
    [],
  );

  const openChangesMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setChangeContextMenu(null);
    const panelRect = panelRef.current?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const left = panelRect ? buttonRect.right - panelRect.left - CHANGES_MENU_WIDTH : buttonRect.right - CHANGES_MENU_WIDTH;
    const top = panelRect ? buttonRect.bottom - panelRect.top + 4 : buttonRect.bottom + 4;
    const maxLeft = Math.max(8, (panelRect?.width ?? window.innerWidth) - CHANGES_MENU_WIDTH - 8);
    const maxTop = Math.max(8, (panelRect?.height ?? window.innerHeight) - CHANGES_MENU_HEIGHT - 8);
    setChangesMenu({
      x: Math.max(8, Math.min(left, maxLeft)),
      y: Math.max(8, Math.min(top, maxTop)),
    });
  }, []);

  const viewEntryChanges = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      setActiveDiffView("workingTree");
      selectEntry(entry);
    },
    [selectEntry],
  );

  const stageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("stage", () => gitClient!.stage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const discardEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      const message = t("projectTools.gitReview.discardConfirm").replace("{path}", entry.path);
      if (!window.confirm(message)) return;
      void runOperation("discard", () =>
        gitClient!.discard(cwd, entry.path, entry.oldPath ?? undefined),
      );
    },
    [cwd, gitClient, runOperation, t],
  );

  const addEntryToGitignore = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("add_to_gitignore", () => gitClient!.addToGitignore(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const stageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("stage_all", () => gitClient!.stageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const unstageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("unstage_all", () => gitClient!.unstageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const discardAllChanges = useCallback(() => {
    setChangesMenu(null);
    const message = t("projectTools.gitReview.discardAllConfirm");
    if (!window.confirm(message)) return;
    void runOperation("discard_all", () => gitClient!.discardAll(cwd));
  }, [cwd, gitClient, runOperation, t]);

  const revealEntryInFileTree = useCallback(
    (entry: GitStatusEntry) => {
      if (!onRevealInFileTree) return;
      setChangeContextMenu(null);
      onRevealInFileTree(revealTargetForEntry(entry));
    },
    [onRevealInFileTree],
  );

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {state.head || t("projectTools.gitReviewTitle")}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {state.repoRoot || disabledMessage || t("projectTools.gitReview.noRepository")}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            title={t("projectTools.gitReview.refresh")}
            aria-label={t("projectTools.gitReview.refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "fetch"}
            title={t("projectTools.gitReview.fetch")}
            onClick={() => void runOperation("fetch", () => gitClient!.fetch(cwd))}
          >
            {t("projectTools.gitReview.fetch")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "pull"}
            title={t("projectTools.gitReview.pull")}
            onClick={() => void runOperation("pull", () => gitClient!.pull(cwd))}
          >
            {t("projectTools.gitReview.pull")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || busy === "push"}
            title={t("projectTools.gitReview.push")}
            aria-label={t("projectTools.gitReview.push")}
            onClick={() => void runOperation("push", () => gitClient!.push(cwd))}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
        </div>
        {state.status === "ready" ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span>
              {t("projectTools.gitReview.statusBase").replace(
                "{value}",
                branchDiff?.baseRef || state.upstream || t("projectTools.gitReview.unresolved"),
              )}
            </span>
            <span>{t("projectTools.gitReview.statusAhead").replace("{count}", String(state.ahead))}</span>
            <span>{t("projectTools.gitReview.statusBehind").replace("{count}", String(state.behind))}</span>
            <span>
              {t("projectTools.gitReview.statusStaged").replace("{count}", String(state.dirtyCounts.staged))}
            </span>
            <span>
              {t("projectTools.gitReview.statusUnstaged").replace("{count}", String(state.dirtyCounts.unstaged))}
            </span>
            <span>
              {t("projectTools.gitReview.statusUntracked").replace("{count}", String(state.dirtyCounts.untracked))}
            </span>
          </div>
        ) : null}
        {!canWrite && disabledMessage ? (
          <div className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {disabledMessage}
          </div>
        ) : null}
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(8rem,14rem)_minmax(0,1fr)] md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex min-h-0 flex-col overflow-hidden border-b border-border md:border-b-0 md:border-r">
          <div className="relative z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-1.5">
            <div className="min-w-0 truncate text-xs font-semibold">
              {t("projectTools.gitReview.changesTitle")}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 w-6 shrink-0 px-0"
              title={t("projectTools.gitReview.changesActions")}
              aria-label={t("projectTools.gitReview.changesActions")}
              onClick={openChangesMenu}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                {t("projectTools.gitReview.noLocalChanges")}
              </div>
            ) : (
              <>
                {visibleEntries.map((entry) => {
                  const selected = entry.path === selectedPath;
                  const contextMenuOpen = entry.path === changeContextMenu?.path;
                  const TypeIcon = getFileTypeIcon(entry.path, "file");
                  const fileName = basename(entry.path);
                  const filePath = parentPath(entry.path);
                  return (
                    <div
                      key={`${entry.kind}:${entry.path}`}
                      className={cn(
                        "select-none border-b border-l-2 border-border/60 border-l-transparent px-3 py-2 transition-colors hover:bg-muted/40",
                        selected && "border-l-emerald-500 bg-emerald-500/10",
                        contextMenuOpen && "border-l-primary bg-primary/10 ring-1 ring-inset ring-primary/35",
                      )}
                      onMouseDown={(event) => {
                        if (event.button === 2) {
                          window.getSelection()?.removeAllRanges();
                        }
                      }}
                      onContextMenu={(event) => openChangeContextMenu(event, entry)}
                    >
                      <button
                        type="button"
                        className="flex w-full select-none items-start gap-2 rounded-sm bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => selectEntry(entry)}
                        title={entry.path}
                      >
                        <TypeIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 select-none">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {fileName}
                          </span>
                          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                            {filePath}
                          </span>
                        </span>
                        <span className={cn("mt-0.5 shrink-0 text-[10px] font-semibold", statusTone(entry))}>
                          {statusLabel(entry)}
                        </span>
                      </button>
                    </div>
                  );
                })}
                {hiddenEntryCount > 0 ? (
                  <div className="border-b border-border/60 px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full text-xs"
                      onClick={() =>
                        setVisibleEntryCount((current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE)
                      }
                    >
                      {t("projectTools.gitReview.showMoreChanges").replace(
                        "{count}",
                        String(Math.min(hiddenEntryCount, CHANGE_ENTRY_RENDER_BATCH_SIZE)),
                      )}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
        <main className="flex h-full min-h-0 flex-col overflow-hidden p-3">
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
            <Input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t("projectTools.gitReview.commitMessagePlaceholder")}
              disabled={writeDisabled}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              disabled={writeDisabled || !commitMessage.trim() || busy === "commit"}
              onClick={() => {
                void runOperation("commit", () => gitClient!.commit(cwd, commitMessage)).then(
                  (ok) => {
                    if (ok) setCommitMessage("");
                  },
                );
              }}
            >
              {busy === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("projectTools.gitReview.commit")}
            </Button>
          </div>
          {selectedEntry ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t("projectTools.gitReview.selected")}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={selectedEntry.path}>
                  {selectedEntry.path}
                </span>
              </div>
              <DiffReviewCard
                activeView={activeDiffView}
                branchDiff={branchDiff}
                branchError={branchError}
                diffLoading={diffLoading}
                onActiveViewChange={setActiveDiffView}
                worktreeDiff={worktreeDiff}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
              {t("projectTools.gitReview.selectFileToViewDiff")}
            </div>
          )}
        </main>
      </div>
      {changesMenu ? (
        <div
          role="menu"
          className="absolute z-[75] min-w-56 select-none overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-xl"
          style={{ left: changesMenu.x, top: changesMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasStageableChanges}
            onClick={stageAllChanges}
          >
            <FilePenLine className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.stageAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasStagedChanges}
            onClick={unstageAllChanges}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.unstageAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasDiscardableChanges}
            onClick={discardAllChanges}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={loading}
            onClick={() => {
              setChangesMenu(null);
              void refresh();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.refreshChanges")}</span>
          </button>
        </div>
      ) : null}
      {changeContextMenu && contextEntry ? (
        <div
          role="menu"
          className="absolute z-[80] min-w-56 select-none overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs text-popover-foreground shadow-xl"
          style={{ left: changeContextMenu.x, top: changeContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            onClick={() => viewEntryChanges(contextEntry)}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.viewChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !contextEntryCanStage}
            onClick={() => stageEntry(contextEntry)}
          >
            <FilePenLine className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.stageChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => discardEntry(contextEntry)}
          >
            <BrushCleaning className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => addEntryToGitignore(contextEntry)}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.addToGitignore")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={!onRevealInFileTree}
            onClick={() => revealEntryInFileTree(contextEntry)}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.revealInFileTree")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
