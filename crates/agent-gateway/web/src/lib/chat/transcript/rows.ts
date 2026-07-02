import type { ToolCall, ToolResultMessage } from "@/lib/agentTypes";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  buildDelegateAgentPlaceholderToolCalls,
  getRoundToolTrace,
  hasRoundContent,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
} from "@/lib/chat/uiMessages";
import type {
  DelegateAgentCardResultDetails,
  DelegateAgentItemResultDetails,
  DelegateAgentResultDetails,
} from "@/lib/tools/builtinTypes";
import {
  type AssistantMeta,
  type ChatEntry,
  type GatewayTranscriptRound,
  hashValue,
  stripRecoveredToolCallMarkup,
} from "@/lib/chatUi";

import type { TranscriptRow, TranscriptRowOrigin, Turn } from "./types";

// The one place transcript rows are built. Consecutive assistant-side
// entries fold into a single assistant row of rounds; rounds without any
// renderable content are dropped, and an assistant row is only emitted when
// at least one round survives — an avatar can therefore never render without
// content next to it.

type AssistantGroupBuilder = {
  id: string;
  rounds: GatewayTranscriptRound[];
  roundIndexByNumber: Map<number, number>;
};

function createTranscriptRound(groupId: string, round: number): GatewayTranscriptRound {
  return {
    key: `${groupId}:r${round}`,
    round,
    blocks: [],
    runningToolCallIds: [],
  };
}

function ensureAssistantGroup(
  builder: AssistantGroupBuilder | null,
  seedEntryId: string,
): AssistantGroupBuilder {
  if (builder) return builder;
  return {
    id: `ag:${seedEntryId}`,
    rounds: [],
    roundIndexByNumber: new Map<number, number>(),
  };
}

function ensureTranscriptRound(
  builder: AssistantGroupBuilder,
  requestedRound?: number,
): GatewayTranscriptRound {
  const roundNumber = requestedRound ?? builder.rounds[builder.rounds.length - 1]?.round ?? 1;
  const existingIndex = builder.roundIndexByNumber.get(roundNumber);
  if (existingIndex !== undefined) {
    return builder.rounds[existingIndex];
  }

  const nextRound = createTranscriptRound(builder.id, roundNumber);
  builder.roundIndexByNumber.set(roundNumber, builder.rounds.length);
  builder.rounds.push(nextRound);
  return nextRound;
}

function updateTranscriptRound(
  builder: AssistantGroupBuilder,
  roundNumber: number,
  updater: (round: GatewayTranscriptRound) => GatewayTranscriptRound,
) {
  const round = ensureTranscriptRound(builder, roundNumber);
  const index = builder.roundIndexByNumber.get(round.round) ?? 0;
  builder.rounds[index] = updater(round);
}

function collapseThinking(round: GatewayTranscriptRound): GatewayTranscriptRound {
  if (!round.thinkingOpen) return round;
  return { ...round, thinkingOpen: false };
}

function mergeAssistantMeta(
  current: AssistantMeta | undefined,
  next: AssistantMeta | undefined,
): AssistantMeta | undefined {
  if (!next) return current;
  return { ...(current ?? {}), ...next };
}

function findToolCallInRound(round: GatewayTranscriptRound, toolCallId: string) {
  return getRoundToolTrace(round).find((item) => item.toolCall.id === toolCallId)?.toolCall;
}

function findPendingToolCallByName(round: GatewayTranscriptRound, name: string) {
  const trace = getRoundToolTrace(round);
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const item = trace[index];
    if (!item) continue;
    if (item.toolCall.name === name && !item.toolResult) {
      return item.toolCall;
    }
  }
  return undefined;
}

function resolveToolCallForResult(
  builder: AssistantGroupBuilder,
  roundNumber: number,
  toolResult: ToolResultMessage,
): ToolCall {
  const requestedRound = ensureTranscriptRound(builder, roundNumber);
  const byId = toolResult.toolCallId && findToolCallInRound(requestedRound, toolResult.toolCallId);
  if (byId) {
    return byId;
  }

  const byName = toolResult.toolName && findPendingToolCallByName(requestedRound, toolResult.toolName);
  if (byName) {
    return byName;
  }

  for (let index = builder.rounds.length - 1; index >= 0; index -= 1) {
    const round = builder.rounds[index];
    if (!round) continue;
    const candidateById = toolResult.toolCallId && findToolCallInRound(round, toolResult.toolCallId);
    if (candidateById) {
      return candidateById;
    }
    const candidateByName =
      toolResult.toolName && findPendingToolCallByName(round, toolResult.toolName);
    if (candidateByName) {
      return candidateByName;
    }
  }

  return {
    type: "toolCall",
    id: toolResult.toolCallId || `orphan:${hashValue([toolResult.toolName, toolResult.content])}`,
    name: toolResult.toolName || "Tool",
    arguments: {},
  } as ToolCall;
}

function asDelegateAgentResultDetails(details: unknown): DelegateAgentResultDetails | null {
  const record =
    details && typeof details === "object" ? (details as Record<string, unknown>) : {};
  return record.kind === "delegate_agent" && Array.isArray(record.agents)
    ? (record as unknown as DelegateAgentResultDetails)
    : null;
}

function readDelegateAgentPrompt(agent: DelegateAgentItemResultDetails) {
  return agent.prompt || agent.description || "";
}

function buildDelegateAgentCardToolCall(params: {
  parentToolResult: ToolResultMessage;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentItemResultDetails;
}): ToolCall {
  const parentToolCallId = params.parentToolResult.toolCallId || "agent";
  return {
    type: "toolCall",
    id: `${parentToolCallId}:agent:${params.index + 1}`,
    name: "Agent",
    arguments: {
      delegate_agent_card: true,
      parent_tool_call_id: parentToolCallId,
      index: params.index + 1,
      total: params.details.agentCount,
      concurrency: params.details.concurrency,
      id: params.agent.id,
      name: params.agent.name,
      role: params.agent.role,
      agent_id: params.agent.agentId,
      prompt: readDelegateAgentPrompt(params.agent),
      mode: params.agent.mode,
    },
  } as ToolCall;
}

function buildDelegateAgentCardToolResult(params: {
  parentToolResult: ToolResultMessage;
  toolCall: ToolCall;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentItemResultDetails;
}): ToolResultMessage {
  const details: DelegateAgentCardResultDetails = {
    kind: "delegate_agent_item",
    parentToolCallId: params.parentToolResult.toolCallId,
    index: params.index,
    total: params.details.agentCount,
    concurrency: params.details.concurrency,
    agent: params.agent,
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [
      {
        type: "text",
        text:
          params.agent.error ||
          params.agent.applyError ||
          params.agent.summary ||
          readDelegateAgentPrompt(params.agent) ||
          "",
      },
    ],
    details,
    isError: params.agent.status === "failed",
    timestamp: params.parentToolResult.timestamp,
  } as ToolResultMessage;
}

function appendDelegateAgentCardsToRound(
  round: GatewayTranscriptRound,
  parentToolResult: ToolResultMessage,
  details: DelegateAgentResultDetails,
): GatewayTranscriptRound {
  let nextRound = round;
  details.agents.forEach((agent, index) => {
    const toolCall = buildDelegateAgentCardToolCall({ parentToolResult, details, index, agent });
    const toolResult = buildDelegateAgentCardToolResult({
      parentToolResult,
      toolCall,
      details,
      index,
      agent,
    });
    nextRound = attachToolResultToRound(nextRound, toolCall, toolResult) as GatewayTranscriptRound;
  });

  const completedIds = new Set([
    parentToolResult.toolCallId,
    ...details.agents.map((_, index) => `${parentToolResult.toolCallId}:agent:${index + 1}`),
  ]);

  return {
    ...nextRound,
    runningToolCallIds: nextRound.runningToolCallIds.filter((id) => !completedIds.has(id)),
  };
}

export function buildRowsFromEntries(
  entries: ChatEntry[],
  origin: TranscriptRowOrigin,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let assistantGroup: AssistantGroupBuilder | null = null;

  const flushAssistantGroup = () => {
    if (!assistantGroup) {
      return;
    }
    // The content gate: rounds that never produced anything renderable
    // (meta-only token carriers, empty leading flushes) are dropped, and a
    // group whose every round dropped emits no row at all.
    const rounds = assistantGroup.rounds.filter((round) => hasRoundContent(round));
    if (rounds.length > 0) {
      rows.push({
        key: assistantGroup.id,
        origin,
        kind: "assistant",
        rounds,
      });
    }
    assistantGroup = null;
  };

  for (const entry of entries) {
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      flushAssistantGroup();
      if (entry.kind === "user") {
        rows.push({
          key: entry.id,
          origin,
          kind: "user",
          text: entry.text,
          attachments: entry.attachments,
          messageRef: entry.messageRef,
        });
      } else if (entry.kind === "checkpoint") {
        rows.push({
          key: entry.id,
          origin,
          kind: "checkpoint",
          content: entry.content,
          summaryId: entry.summaryId,
          coveredMessageCount: entry.coveredMessageCount,
          generatedBy: entry.generatedBy,
          timestamp: entry.timestamp,
        });
      } else {
        rows.push({ key: entry.id, origin, kind: "error", text: entry.text });
      }
      continue;
    }

    assistantGroup = ensureAssistantGroup(assistantGroup, entry.id);
    const roundNumber =
      entry.round ?? assistantGroup.rounds[assistantGroup.rounds.length - 1]?.round ?? 1;

    if (entry.kind === "assistant") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        let nextRound = round;
        if (entry.text !== "") {
          nextRound = appendTextDeltaToRound(
            collapseThinking(nextRound),
            entry.text,
          ) as GatewayTranscriptRound;
        }
        return {
          ...nextRound,
          meta: mergeAssistantMeta(nextRound.meta, entry.meta),
        };
      });
      continue;
    }

    if (entry.kind === "thinking") {
      const sanitizedThinking = stripRecoveredToolCallMarkup(entry.text);
      if (sanitizedThinking === "") {
        continue;
      }
      updateTranscriptRound(assistantGroup, roundNumber, (round) => ({
        ...(appendThinkingDeltaToRound(round, sanitizedThinking) as GatewayTranscriptRound),
        thinkingOpen: true,
      }));
      continue;
    }

    if (entry.kind === "tool_call") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const visibleToolCalls = buildDelegateAgentPlaceholderToolCalls(entry.toolCall);
        const runningCandidateIds =
          visibleToolCalls.length > 0
            ? visibleToolCalls.map((toolCall) => toolCall.id)
            : entry.toolCall.id
              ? [entry.toolCall.id]
              : [];
        const withToolCall = upsertToolCallToRound(
          collapseThinking(round),
          entry.toolCall,
        ) as GatewayTranscriptRound;
        const visibleToolCallIds = new Set(
          getRoundToolTrace(withToolCall)
            .map((item) => item.toolCall.id)
            .filter((id): id is string => Boolean(id)),
        );
        const runningToolCallIds = runningCandidateIds.reduce(
          (ids, id) => (visibleToolCallIds.has(id) && !ids.includes(id) ? [...ids, id] : ids),
          withToolCall.runningToolCallIds,
        );
        return { ...withToolCall, runningToolCallIds };
      });
      continue;
    }

    if (entry.kind === "hosted_search") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const nextRound = upsertHostedSearchToRound(
          collapseThinking(round),
          entry.hostedSearch,
        ) as GatewayTranscriptRound;
        const visibleToolCallIds = new Set(
          getRoundToolTrace(nextRound)
            .map((item) => item.toolCall.id)
            .filter((id): id is string => Boolean(id)),
        );
        return {
          ...nextRound,
          runningToolCallIds: nextRound.runningToolCallIds.filter((id) =>
            visibleToolCallIds.has(id),
          ),
        };
      });
      continue;
    }

    if (entry.kind === "tool_result") {
      const delegateDetails = asDelegateAgentResultDetails(entry.toolResult.details);
      if (delegateDetails) {
        updateTranscriptRound(assistantGroup, roundNumber, (round) =>
          appendDelegateAgentCardsToRound(collapseThinking(round), entry.toolResult, delegateDetails),
        );
        continue;
      }

      const toolCall = resolveToolCallForResult(assistantGroup, roundNumber, entry.toolResult);
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const withResult = attachToolResultToRound(
          collapseThinking(round),
          toolCall,
          entry.toolResult,
        ) as GatewayTranscriptRound;
        return {
          ...withResult,
          runningToolCallIds: withResult.runningToolCallIds.filter((id) => id !== toolCall.id),
        };
      });
    }
  }

  flushAssistantGroup();
  return rows;
}

// A turn's rows: the user bubble first, then its run's assistant content —
// derived from one object, so the order is fixed by construction.
export function buildTurnRows(turn: Turn): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (turn.user) {
    rows.push({
      key: turn.user.id,
      origin: "stream",
      kind: "user",
      text: turn.user.text,
      attachments: turn.user.attachments,
      messageRef: turn.user.messageRef,
    });
  }
  for (const row of buildRowsFromEntries(turn.entries, "stream")) {
    rows.push(row.kind === "assistant" ? { ...row, turnKey: turn.key } : row);
  }
  return rows;
}

// Row keys feed React reconciliation and the virtualizer's measurement cache;
// a duplicate key collapses row positions onto each other. Ids are unique by
// construction, but this single canonical pass makes the guarantee local to
// the builder instead of distributed across every producer. Pass `seen` to
// dedupe one region against keys already taken by another.
export function dedupeRowKeys(rows: TranscriptRow[], seen = new Set<string>()): TranscriptRow[] {
  let next: TranscriptRow[] | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    let key = row.key;
    if (seen.has(key)) {
      let suffix = 2;
      while (seen.has(`${key}#${suffix}`)) {
        suffix += 1;
      }
      key = `${key}#${suffix}`;
      if (!next) {
        next = rows.slice();
      }
      next[index] = { ...row, key };
    }
    seen.add(key);
  }
  return next ?? rows;
}
