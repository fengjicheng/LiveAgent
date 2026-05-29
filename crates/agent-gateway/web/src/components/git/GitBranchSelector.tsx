import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, GitBranch, Loader2, Plus, RefreshCw } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { cn } from "../../lib/shared/utils";
import type { GitBranch as GitBranchInfo, GitClient, GitRepositoryState } from "../../lib/git/types";
import { emptyGitRepositoryState } from "../../lib/git/types";
import { useLocale } from "../../i18n";

function dirtyCount(state: GitRepositoryState) {
  return (
    state.dirtyCounts.staged +
    state.dirtyCounts.unstaged +
    state.dirtyCounts.untracked +
    state.dirtyCounts.conflicted
  );
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

export function GitBranchSelector(props: {
  workdir: string;
  gitClient?: GitClient | null;
  disabled?: boolean;
  canWrite?: boolean;
  disabledMessage?: string;
  onStateChange?: (state: GitRepositoryState) => void;
  onChanged?: () => void;
}) {
  const {
    workdir,
    gitClient,
    disabled,
    canWrite = true,
    disabledMessage,
    onStateChange,
    onChanged,
  } = props;
  const { t } = useLocale();
  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(workdir));
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftBranch, setDraftBranch] = useState("");

  const refresh = useCallback(async () => {
    if (!gitClient || !workdir.trim()) {
      const next = emptyGitRepositoryState(workdir);
      setState(next);
      setBranches([]);
      onStateChange?.(next);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await gitClient.branches(workdir);
      setState(response.state);
      setBranches(response.branches);
      onStateChange?.(response.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      const next = emptyGitRepositoryState(workdir);
      setState(next);
      onStateChange?.(next);
    } finally {
      setLoading(false);
    }
  }, [gitClient, onStateChange, workdir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const localBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "local"),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "remote"),
    [branches],
  );

  const runBranchMutation = useCallback(
    async (task: () => Promise<unknown>) => {
      if (!gitClient || !workdir.trim()) return;
      if (!canWrite) {
        setError(disabledMessage || t("git.branchSelector.writeDisabled"));
        return false;
      }
      setMutating(true);
      setError("");
      try {
        const result = await task();
        assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
        await refresh();
        onChanged?.();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setMutating(false);
      }
    },
    [canWrite, disabledMessage, gitClient, onChanged, refresh, t, workdir],
  );

  const selectBranch = useCallback(
    (branch: GitBranchInfo) => {
      void runBranchMutation(() => gitClient!.switchBranch(workdir, branch.fullName, branch.kind));
    },
    [gitClient, runBranchMutation, workdir],
  );

  const createBranch = useCallback(() => {
    const name = draftBranch.trim();
    if (!name) return;
    void runBranchMutation(() => gitClient!.createBranch(workdir, name)).then((ok) => {
      if (!ok) return;
      setDraftBranch("");
      setCreating(false);
    });
  }, [draftBranch, gitClient, runBranchMutation, workdir]);

  const noRepo = state.status !== "ready";
  const count = dirtyCount(state);
  const label = noRepo ? t("git.branchSelector.noRepoShort") : state.head || t("git.branchSelector.detached");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || !gitClient || !workdir.trim()}
        className={cn(
          "composer-reasoning-trigger inline-flex h-8 max-w-[13rem] shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium outline-hidden transition-colors",
          noRepo
            ? "border-transparent bg-foreground/[0.04] text-muted-foreground"
            : "border-emerald-300/25 bg-emerald-50/65 text-foreground hover:bg-emerald-50 dark:border-emerald-300/15 dark:bg-emerald-400/[0.08]",
          "disabled:pointer-events-none disabled:opacity-45",
        )}
        title={error || (!canWrite ? disabledMessage : "") || label}
      >
        {loading || mutating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
        )}
        <span className="min-w-0 truncate">{label}</span>
        {!noRepo && state.ahead + state.behind > 0 ? (
          <span className="rounded-full bg-foreground/10 px-1.5 text-[10px]">
            {state.ahead > 0 ? `↑${state.ahead}` : ""}
            {state.behind > 0 ? `↓${state.behind}` : ""}
          </span>
        ) : null}
        {!noRepo && count > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">
            {count}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" side="top" align="start">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {state.repoRoot || error || t("git.branchSelector.noRepository")}
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void refresh()}
            title={t("git.branchSelector.refresh")}
            aria-label={t("git.branchSelector.refresh")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
        {error ? <div className="px-2 py-1 text-xs text-destructive">{error}</div> : null}
        {!canWrite && disabledMessage ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">{disabledMessage}</div>
        ) : null}
        {noRepo ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {t("git.branchSelector.noRepositoryFound")}
          </div>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("git.branchSelector.localBranches")}
            </DropdownMenuLabel>
            {localBranches.map((branch) => (
              <DropdownMenuItem
                key={branch.fullName}
                disabled={branch.current || mutating || !canWrite}
                onSelect={() => selectBranch(branch)}
                className="gap-2 text-xs"
              >
                {branch.current ? <Check className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("git.branchSelector.remoteBranches")}
            </DropdownMenuLabel>
            {remoteBranches.slice(0, 40).map((branch) => (
              <DropdownMenuItem
                key={branch.fullName}
                disabled={mutating || !canWrite}
                onSelect={() => selectBranch(branch)}
                className="gap-2 text-xs"
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate">{branch.fullName}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {creating ? (
              <div className="flex items-center gap-1 px-2 py-1.5">
                <Input
                  value={draftBranch}
                  onChange={(event) => setDraftBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createBranch();
                    if (event.key === "Escape") setCreating(false);
                  }}
                  placeholder={t("git.branchSelector.newBranchPlaceholder")}
                  className="h-8 text-xs"
                  autoFocus
                />
                <button
                  type="button"
                  className="rounded bg-foreground px-2 py-1.5 text-xs text-background"
                  onClick={createBranch}
                >
                  {t("git.branchSelector.create")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!canWrite || mutating}
                title={!canWrite ? disabledMessage : undefined}
                className="relative flex w-full cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setCreating(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("git.branchSelector.createNewBranch")}
              </button>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
