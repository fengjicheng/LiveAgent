import type { Tool } from "@earendil-works/pi-ai";
import { parseSubagentRunState } from "../../tools/delegate/history";
import {
  createAgentTemplateLookup,
  identitiesByLogicalAgent,
  latestRunsByLogicalAgent,
  normalizeLookupKey,
} from "../../tools/delegate/identity";
import { normalizeSubagentRunMode } from "../../tools/delegate/input";
import { buildSubagentSystemPrompt } from "../../tools/delegate/prompts";
import type {
  DelegateAgentInput,
  DelegateAgentTemplate,
  DelegateApplyPolicy,
  DelegateTaskIntent,
  DelegateWorktreeInfo,
} from "../../tools/delegate/types";
import {
  type ConversationViewState,
  normalizeConversationState,
} from "../conversation/conversationState";
import {
  defaultSubagentHistoryRecorder,
  type SubagentHistoryRecorder,
  type SubagentIdentityRecord,
  type SubagentRunHistoryInput,
  type SubagentRunSummary,
} from "./subagentHistory";

const DEFAULT_WARMUP_LIMIT = 16;
const DEFAULT_WARMUP_CONCURRENCY = 2;
const DEFAULT_MAX_ENTRIES = 64;

type RuntimeEntryStatus = "loading" | "ready" | "failed";

type RuntimeEntry = {
  conversationId: string;
  logicalAgentId: string;
  runId: string;
  status: RuntimeEntryStatus;
  state?: ConversationViewState;
  runSummary?: SubagentRunSummary;
  identity?: SubagentIdentityRecord;
  error?: string;
  promise?: Promise<void>;
  updatedAt: number;
};

export type SubagentRuntimeStateRequest = {
  parentConversationId?: string;
  runSummary: SubagentRunSummary;
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity: SubagentIdentityRecord;
  tools: Tool[];
  worktree?: DelegateWorktreeInfo;
};

export type SubagentRuntimeRememberInput = {
  input: SubagentRunHistoryInput;
  identity?: SubagentIdentityRecord;
};

export type SubagentRuntimeWarmupInput = {
  parentConversationId: string;
  agentTemplates?: DelegateAgentTemplate[];
  limit?: number;
};

export type SubagentRuntimeManager = {
  warmupConversation: (input: SubagentRuntimeWarmupInput) => void;
  getHydratedState: (input: SubagentRuntimeStateRequest) => ConversationViewState | null;
  hydrateState: (input: SubagentRuntimeStateRequest) => Promise<ConversationViewState | null>;
  rememberRunState: (input: SubagentRuntimeRememberInput) => void;
  invalidateConversation: (parentConversationId: string) => void;
  disposeConversation: (parentConversationId: string) => void;
  disposeAll: () => void;
};

export type SubagentRuntimeManagerOptions = {
  subagentHistory?: SubagentHistoryRecorder;
  warmupLimit?: number;
  warmupConcurrency?: number;
  maxEntries?: number;
};

function conversationKey(parentConversationId?: string) {
  return parentConversationId?.trim() ?? "";
}

function entryKey(parentConversationId: string | undefined, logicalAgentId: string) {
  const conversationId = conversationKey(parentConversationId);
  const agentId = logicalAgentId.trim();
  if (!conversationId || !agentId) return "";
  return `${conversationId}\u0000${agentId}`;
}

function taskIntentFromIdentity(value: string | undefined): DelegateTaskIntent {
  return value === "communication" ||
    value === "research" ||
    value === "review" ||
    value === "implementation" ||
    value === "document_generation"
    ? value
    : "research";
}

function applyPolicyFromIdentity(value: string | undefined): DelegateApplyPolicy {
  return value === "none" || value === "explicit" || value === "auto" ? value : "none";
}

function buildWarmupTask(params: {
  run: SubagentRunSummary;
  identity: SubagentIdentityRecord;
}): DelegateAgentInput {
  const mode = normalizeSubagentRunMode(params.run.mode) ?? "readonly";
  return {
    id: params.identity.logicalAgentId,
    name: params.identity.displayName,
    role: params.identity.role,
    identity: params.identity.identityPrompt,
    prompt: params.run.description || params.identity.displayName,
    agentId: params.identity.agentId ?? params.run.agentId,
    mode,
    modeSpecified: true,
    taskIntent: taskIntentFromIdentity(params.identity.defaultTaskIntent),
    taskIntentSpecified: true,
    applyPolicy: applyPolicyFromIdentity(params.identity.defaultApplyPolicy),
    applyPolicySpecified: true,
    allowedOutputPaths: [],
    resume: true,
    retainWorktree: false,
  };
}

function rebaseStateMeta(
  params: SubagentRuntimeStateRequest & {
    state: ConversationViewState;
  },
) {
  return normalizeConversationState({
    meta: {
      ...params.state.meta,
      systemPrompt: buildSubagentSystemPrompt({
        task: params.task,
        template: params.template,
        identity: params.identity,
        worktree: params.worktree,
        agentIndex: Math.max(0, params.runSummary.agentIndex),
        agentTotal: Math.max(1, params.runSummary.agentTotal),
      }),
      tools: params.tools,
    },
    segments: params.state.segments,
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  async function runLoop() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(
    new Array(Math.min(Math.max(1, concurrency), items.length)).fill(0).map(() => runLoop()),
  );
}

export function createSubagentRuntimeManager(
  options: SubagentRuntimeManagerOptions = {},
): SubagentRuntimeManager {
  const entries = new Map<string, RuntimeEntry>();
  const warmupGenerations = new Map<string, number>();
  const subagentHistory = options.subagentHistory ?? defaultSubagentHistoryRecorder;
  const warmupLimit = Math.max(1, Math.floor(options.warmupLimit ?? DEFAULT_WARMUP_LIMIT));
  const warmupConcurrency = Math.max(
    1,
    Math.floor(options.warmupConcurrency ?? DEFAULT_WARMUP_CONCURRENCY),
  );
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));

  function pruneEntries() {
    while (entries.size > maxEntries) {
      const oldest = Array.from(entries.entries()).sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
      )[0];
      if (!oldest) return;
      entries.delete(oldest[0]);
    }
  }

  function setEntry(entry: RuntimeEntry) {
    const key = entryKey(entry.conversationId, entry.logicalAgentId);
    if (!key) return;
    entries.set(key, entry);
    pruneEntries();
  }

  function getEntry(parentConversationId: string | undefined, logicalAgentId: string) {
    const key = entryKey(parentConversationId, logicalAgentId);
    return key ? entries.get(key) : undefined;
  }

  function getHydratedState(input: SubagentRuntimeStateRequest) {
    const parentConversationId = conversationKey(input.parentConversationId);
    if (!parentConversationId) return null;
    const entry = getEntry(parentConversationId, input.runSummary.logicalAgentId);
    if (!entry || entry.status !== "ready" || entry.runId !== input.runSummary.id || !entry.state) {
      return null;
    }
    entry.updatedAt = Date.now();
    return rebaseStateMeta({
      ...input,
      state: entry.state,
    });
  }

  async function hydrateEntry(params: {
    parentConversationId: string;
    run: SubagentRunSummary;
    identity: SubagentIdentityRecord;
    template?: DelegateAgentTemplate;
    tools: Tool[];
    task?: DelegateAgentInput;
    worktree?: DelegateWorktreeInfo;
  }) {
    const key = entryKey(params.parentConversationId, params.run.logicalAgentId);
    if (!key) return;
    const existing = entries.get(key);
    if (existing?.status === "ready" && existing.runId === params.run.id) return;
    if (existing?.status === "loading" && existing.runId === params.run.id) {
      await existing.promise;
      return;
    }

    const task =
      params.task ??
      buildWarmupTask({
        run: params.run,
        identity: params.identity,
      });
    const nextEntry: RuntimeEntry = {
      conversationId: params.parentConversationId,
      logicalAgentId: params.run.logicalAgentId,
      runId: params.run.id,
      runSummary: params.run,
      identity: params.identity,
      status: "loading",
      updatedAt: Date.now(),
    };
    const promise = (async () => {
      try {
        const loadRunState = subagentHistory.getRunState ?? subagentHistory.getRun;
        const record = await loadRunState?.(params.run.id);
        if (!record) {
          nextEntry.status = "failed";
          nextEntry.error = "Subagent run state not found";
          nextEntry.updatedAt = Date.now();
          return;
        }
        const state = parseSubagentRunState({
          record,
          task,
          template: params.template,
          identity: params.identity,
          worktree: params.worktree,
          tools: params.tools,
        });
        if (!state) {
          nextEntry.status = "failed";
          nextEntry.error = "Subagent run state could not be parsed";
          nextEntry.updatedAt = Date.now();
          return;
        }
        nextEntry.state = state;
        nextEntry.status = "ready";
        nextEntry.error = undefined;
        nextEntry.updatedAt = Date.now();
      } catch (error) {
        nextEntry.status = "failed";
        nextEntry.error = error instanceof Error ? error.message : String(error);
        nextEntry.updatedAt = Date.now();
      } finally {
        nextEntry.promise = undefined;
      }
    })();
    nextEntry.promise = promise;
    setEntry(nextEntry);
    await promise;
  }

  function disposeConversation(parentConversationId: string) {
    const id = parentConversationId.trim();
    if (!id) return;
    warmupGenerations.set(id, (warmupGenerations.get(id) ?? 0) + 1);
    for (const [key, entry] of entries.entries()) {
      if (entry.conversationId === id) {
        entries.delete(key);
      }
    }
  }

  return {
    warmupConversation(input) {
      const parentConversationId = input.parentConversationId.trim();
      if (!parentConversationId) return;
      const generation = (warmupGenerations.get(parentConversationId) ?? 0) + 1;
      warmupGenerations.set(parentConversationId, generation);
      const limit = Math.max(1, Math.floor(input.limit ?? warmupLimit));
      const templates = input.agentTemplates ?? [];
      const templateLookup = createAgentTemplateLookup(templates);

      void (async () => {
        let identities: SubagentIdentityRecord[] = [];
        let runs: SubagentRunSummary[] = [];
        try {
          [identities, runs] = await Promise.all([
            subagentHistory.listIdentities?.({
              parentConversationId,
              limit: 200,
            }) ?? Promise.resolve([]),
            subagentHistory.listRuns?.({
              parentConversationId,
              limit: 200,
            }) ?? Promise.resolve([]),
          ]);
        } catch (error) {
          console.warn("Failed to warm up delegated subagents", error);
          return;
        }
        if (warmupGenerations.get(parentConversationId) !== generation) return;

        const identitiesById = identitiesByLogicalAgent(identities);
        const latestRunsById = latestRunsByLogicalAgent(runs);
        const candidates = Array.from(latestRunsById.values())
          .filter((run) => identitiesById.has(run.logicalAgentId))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, limit);

        await runWithConcurrency(candidates, warmupConcurrency, async (run) => {
          if (warmupGenerations.get(parentConversationId) !== generation) return;
          const identity = identitiesById.get(run.logicalAgentId);
          if (!identity) return;
          const task = buildWarmupTask({ run, identity });
          const template = task.agentId
            ? templateLookup.get(normalizeLookupKey(task.agentId))
            : undefined;
          await hydrateEntry({
            parentConversationId,
            run,
            identity,
            template,
            task,
            tools: [],
          });
        });
      })();
    },

    getHydratedState,

    async hydrateState(input) {
      const parentConversationId = conversationKey(input.parentConversationId);
      if (!parentConversationId) return null;
      await hydrateEntry({
        parentConversationId,
        run: input.runSummary,
        identity: input.identity,
        template: input.template,
        task: input.task,
        tools: input.tools,
        worktree: input.worktree,
      });
      return getHydratedState(input);
    },

    rememberRunState({ input, identity }) {
      const parentConversationId = conversationKey(input.parentConversationId);
      const logicalAgentId = input.logicalAgentId.trim();
      if (!parentConversationId || !logicalAgentId) return;
      setEntry({
        conversationId: parentConversationId,
        logicalAgentId,
        runId: input.id,
        status: "ready",
        state: input.state,
        identity,
        runSummary: {
          id: input.id,
          parentConversationId,
          parentToolCallId: input.parentToolCallId,
          parentToolName: input.parentToolName,
          agentIndex: input.agentIndex,
          agentTotal: input.agentTotal,
          logicalAgentId,
          agentId: input.agentId,
          agentName: input.agentName,
          description: input.description,
          mode: input.mode,
          status: input.status,
          providerId: input.providerId,
          model: input.model,
          sessionId: input.sessionId,
          workdir: input.workdir,
          worktreeRoot: input.worktreeRoot,
          branchName: input.branchName,
          messageCount: input.state.meta.totalMessageCount,
          roundCount: input.roundCount,
          toolCallCount: input.toolCallCount,
          compactionCount: input.compactionCount,
          summary: input.summary,
          error: input.error,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          updatedAt: input.updatedAt ?? Date.now(),
        },
        updatedAt: Date.now(),
      });
    },

    invalidateConversation(parentConversationId) {
      disposeConversation(parentConversationId);
    },

    disposeConversation,

    disposeAll() {
      for (const id of warmupGenerations.keys()) {
        warmupGenerations.set(id, (warmupGenerations.get(id) ?? 0) + 1);
      }
      entries.clear();
    },
  };
}
