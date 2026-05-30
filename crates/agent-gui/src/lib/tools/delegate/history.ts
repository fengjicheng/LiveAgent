import type { Tool, ToolCall } from "@earendil-works/pi-ai";

import type {
  ConversationViewState,
  StoredContextSegment,
} from "../../chat/conversation/conversationState";
import { normalizeConversationState } from "../../chat/conversation/conversationState";
import type {
  SubagentIdentityRecord,
  SubagentRunRecord,
  SubagentRunSummary,
} from "../../chat/subagent/subagentHistory";
import type { ProviderId } from "../../settings";
import type { DelegateAgentItemResultDetails } from "../builtinTypes";
import { buildSubagentSystemPrompt } from "./prompts";
import type { DelegateAgentInput, DelegateAgentTemplate, DelegateWorktreeInfo } from "./types";
import { asObject, normalizeErrorMessage, randomIdSuffix, sanitizeLabelPart } from "./utils";

export function parseSubagentRunState(params: {
  record: SubagentRunRecord;
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity: SubagentIdentityRecord;
  worktree?: DelegateWorktreeInfo;
  tools: Tool[];
}): ConversationViewState | null {
  try {
    const rawMeta = JSON.parse(params.record.contextMetaJson || "{}");
    const segments: StoredContextSegment[] = params.record.segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      segmentId: segment.segmentId,
      summary: segment.summaryJson ? JSON.parse(segment.summaryJson) : undefined,
      messages: JSON.parse(segment.messagesJson || "[]"),
      messageCount: segment.messageCount,
      startMessageId: segment.startMessageId,
      endMessageId: segment.endMessageId,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    }));
    if (segments.length === 0) return null;
    return normalizeConversationState({
      meta: {
        ...asObject(rawMeta),
        systemPrompt: buildSubagentSystemPrompt({
          task: params.task,
          template: params.template,
          identity: params.identity,
          worktree: params.worktree,
          agentIndex: Math.max(0, params.record.agentIndex),
          agentTotal: Math.max(1, params.record.agentTotal),
        }),
        tools: params.tools,
      },
      segments,
    });
  } catch (error) {
    console.warn("Failed to restore delegated subagent state", error);
    return null;
  }
}

export function buildSubagentRunId(params: {
  parentToolCallId: string;
  agent: DelegateAgentInput;
  index: number;
}) {
  const call = sanitizeLabelPart(params.parentToolCallId, "call");
  const agent = sanitizeLabelPart(params.agent.id, `agent-${params.index + 1}`);
  return `${call}:agent:${params.index + 1}:${agent}:${randomIdSuffix()}`;
}

export function rememberSubagentRun(
  existingRunsByLogicalAgent: Map<string, SubagentRunSummary>,
  input: {
    runId: string;
    task: DelegateAgentInput;
    result: DelegateAgentItemResultDetails;
    parentConversationId?: string;
    parentToolCall: ToolCall;
    agentIndex: number;
    agentTotal: number;
    providerId: ProviderId;
    model: string;
    sessionId?: string;
    startedAt: number;
    endedAt?: number;
    updatedAt: number;
  },
) {
  existingRunsByLogicalAgent.set(input.task.id, {
    id: input.runId,
    parentConversationId: input.parentConversationId,
    parentToolCallId: input.parentToolCall.id,
    parentToolName: input.parentToolCall.name,
    agentIndex: input.agentIndex,
    agentTotal: input.agentTotal,
    logicalAgentId: input.task.id,
    agentId: input.task.agentId,
    agentName: input.result.name,
    description: input.result.prompt,
    mode: input.result.mode,
    status: input.result.status === "failed" ? "failed" : "completed",
    providerId: input.providerId,
    model: input.model,
    sessionId: input.sessionId,
    workdir: input.result.workdir,
    worktreeRoot: input.result.worktreeRoot,
    branchName: input.result.branchName,
    messageCount: 0,
    roundCount: input.result.rounds,
    toolCallCount: input.result.toolCalls,
    compactionCount: 0,
    summary: input.result.summary,
    error: input.result.error,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    updatedAt: input.updatedAt,
  });
}

export function normalizeHistoryError(error: unknown) {
  return normalizeErrorMessage(
    error instanceof Error ? error.message : String(error),
    "Failed to persist delegated subagent history",
  );
}
