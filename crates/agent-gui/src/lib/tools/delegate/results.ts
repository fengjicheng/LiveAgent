import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import type { SubagentIdentityRecord } from "../../chat/subagent/subagentHistory";
import type {
  DelegateAgentCardResultDetails,
  DelegateAgentItemResultDetails,
  DelegateAgentResultDetails,
} from "../builtinTypes";
import { DELEGATE_TOOL_NAME } from "./constants";
import type { DelegateAgentInput } from "./types";

export function buildDelegateResultText(details: DelegateAgentResultDetails) {
  const lines = [
    `Delegated agent results: ${details.agents.length} agent(s), concurrency=${details.concurrency}, mode=${details.mode}, read_only=${details.readOnly}`,
  ];

  for (const [index, task] of details.agents.entries()) {
    lines.push(
      "",
      `${index + 1}. [${task.status}] ${task.name || task.id} (${task.id}) - ${task.prompt}`,
      task.runId ? `run_id=${task.runId}` : "",
      task.role ? `role=${task.role}` : "",
      `mode=${task.mode}`,
      task.taskIntent ? `intent=${task.taskIntent}` : "",
      task.applyPolicy ? `apply_policy=${task.applyPolicy}` : "",
      task.agentName
        ? `template=${task.agentName}`
        : task.agentId
          ? `template=${task.agentId}`
          : "template=generic",
      `duration_ms=${task.durationMs} rounds=${task.rounds} tool_calls=${task.toolCalls}`,
      task.worktreeRoot ? `worktree=${task.worktreeRoot}` : "",
      task.branchName ? `branch=${task.branchName}` : "",
      typeof task.changed === "boolean" ? `changed=${task.changed}` : "",
      task.applyStatus ? `apply=${task.applyStatus}` : "",
      task.applyMethod ? `apply_method=${task.applyMethod}` : "",
      typeof task.applyPatchBytes === "number" ? `apply_patch_bytes=${task.applyPatchBytes}` : "",
      task.applySkippedReason ? `apply_skipped_reason=${task.applySkippedReason}` : "",
      task.applyFallbackReason ? `apply_fallback_reason=${task.applyFallbackReason}` : "",
      task.applyError ? `apply_error=${task.applyError}` : "",
      task.appliedToWorkdir ? `applied_to=${task.appliedToWorkdir}` : "",
      task.worktreeCleanupStatus ? `worktree_cleanup=${task.worktreeCleanupStatus}` : "",
      task.worktreeCleanupReason ? `worktree_cleanup_reason=${task.worktreeCleanupReason}` : "",
      typeof task.worktreeBranchDeleted === "boolean"
        ? `worktree_branch_deleted=${task.worktreeBranchDeleted}`
        : "",
      task.worktreeCleanupError ? `worktree_cleanup_error=${task.worktreeCleanupError}` : "",
      task.applyCopiedFiles && task.applyCopiedFiles.length > 0
        ? `copied:\n${task.applyCopiedFiles.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.applyDeletedFiles && task.applyDeletedFiles.length > 0
        ? `deleted:\n${task.applyDeletedFiles.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.applyConflictFiles && task.applyConflictFiles.length > 0
        ? `apply_conflicts:\n${task.applyConflictFiles.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.allowedOutputPaths && task.allowedOutputPaths.length > 0
        ? `allowed_output_paths:\n${task.allowedOutputPaths.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.candidateArtifacts && task.candidateArtifacts.length > 0
        ? `candidate_artifacts:\n${task.candidateArtifacts.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.diffStat ? `diff_stat:\n${task.diffStat}` : "",
      task.untrackedFiles && task.untrackedFiles.length > 0
        ? `untracked:\n${task.untrackedFiles.map((file) => `- ${file}`).join("\n")}`
        : "",
      task.error ? `error=${task.error}` : "summary:",
      task.summary || "(empty summary)",
    );
  }

  return lines.filter((line) => line !== "").join("\n");
}

export function buildDelegateAgentCardToolCall(params: {
  parentToolCall: ToolCall;
  agent: DelegateAgentInput;
  identity: SubagentIdentityRecord;
  index: number;
  total: number;
  concurrency: number;
}): ToolCall {
  return {
    type: "toolCall",
    id: `${params.parentToolCall.id}:agent:${params.index + 1}`,
    name: DELEGATE_TOOL_NAME,
    arguments: {
      delegate_agent_card: true,
      parent_tool_call_id: params.parentToolCall.id,
      index: params.index + 1,
      total: params.total,
      concurrency: params.concurrency,
      id: params.agent.id,
      name: params.identity.displayName,
      role: params.identity.role,
      agent_id: params.agent.agentId,
      prompt: params.agent.prompt,
      mode: params.agent.mode,
      task_intent: params.agent.taskIntent,
      apply_policy: params.agent.applyPolicy,
      allowed_output_paths: params.agent.allowedOutputPaths,
    },
  };
}

export function buildDelegateAgentCardResult(params: {
  parentToolCall: ToolCall;
  toolCall: ToolCall;
  agent: DelegateAgentItemResultDetails;
  index: number;
  total: number;
  concurrency: number;
}): ToolResultMessage {
  const details: DelegateAgentCardResultDetails = {
    kind: "delegate_agent_item",
    parentToolCallId: params.parentToolCall.id,
    index: params.index,
    total: params.total,
    concurrency: params.concurrency,
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
          params.agent.prompt,
      },
    ],
    details,
    isError: params.agent.status === "failed",
    timestamp: Date.now(),
  };
}
