import type { Context, Message, Tool } from "@earendil-works/pi-ai";

import type {
  SubagentIdentityRecord,
  SubagentRunSummary,
} from "../../chat/subagent/subagentHistory";
import type { DelegateAgentInput, DelegateAgentTemplate, DelegateWorktreeInfo } from "./types";

export function buildSubagentSystemPrompt(params: {
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity: SubagentIdentityRecord;
  worktree?: DelegateWorktreeInfo;
  agentIndex?: number;
  agentTotal?: number;
  messageBusEnabled?: boolean;
}) {
  const displayName = params.identity.displayName.trim();
  const role = params.identity.role.trim();
  const teamPosition =
    typeof params.agentIndex === "number" && typeof params.agentTotal === "number"
      ? `${params.agentIndex + 1} of ${params.agentTotal}`
      : "standalone";
  const templateLine = params.template
    ? `- Configured template: ${params.template.name} (${params.template.id})`
    : params.task.agentId
      ? `- Requested template: ${params.task.agentId}`
      : null;
  const identity = [
    `You are ${displayName}, a named delegated LiveAgent subagent.`,
    "",
    "Stable subagent identity:",
    `- Name: ${displayName}`,
    `- Stable id: ${params.identity.logicalAgentId}`,
    `- Role: ${role}`,
    `- Team position: ${teamPosition}`,
    `- Execution mode: ${params.task.mode}`,
    `- Task intent: ${params.task.taskIntent}`,
    `- Apply policy: ${params.task.applyPolicy}`,
    params.task.allowedOutputPaths.length > 0
      ? `- Allowed output paths: ${params.task.allowedOutputPaths.join(", ")}`
      : null,
    templateLine,
    "Keep this identity across resumed turns. Work as this named agent, not as the parent agent or the end user.",
    "",
    "Identity instructions:",
    params.identity.identityPrompt.trim(),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const lines =
    params.task.mode === "worktree"
      ? [
          identity,
          "You are running in an isolated git worktree.",
          "Complete only the assigned agent job and report concise findings back to the parent agent.",
          "Do not address the end user directly. Do not ask follow-up questions.",
          "You may inspect, edit, create, and delete files, run non-interactive shell commands inside your assigned worktree, and use enabled MCP business tools when available. Do not spawn more subagents.",
          "The worktree isolates workspace file changes from the parent agent, but it does not isolate global application state. Do not modify LiveAgent settings, MCP server configuration, cron tasks, or user-level skills. MCP configuration management is not available; only enabled MCP business tools may be used.",
          params.messageBusEnabled
            ? "Do not create files just to communicate your answer, record a role-play response, or pass notes to another agent. Use SendMessage for cross-agent messages and questions; use the final report only as your concise completion summary to the parent agent. Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary."
            : "Do not create files just to communicate your answer, record a role-play response, or pass notes to another agent. Use your final report as the communication channel to the parent agent.",
          params.task.applyPolicy === "auto"
            ? "If you complete successfully, LiveAgent may automatically apply your implementation worktree patch back to the parent workspace. Your final report should describe what changed; do not tell the parent agent to manually copy your diff."
            : params.task.applyPolicy === "explicit"
              ? "LiveAgent will apply worktree changes only when every changed file is inside the allowed output paths. Otherwise, changed files remain candidate artifacts for review."
              : "LiveAgent will not apply your worktree file changes back to the parent workspace for this task. Return the useful result in your final report.",
          params.worktree
            ? `Assigned worktree root: ${params.worktree.worktree_root}\nAssigned workdir: ${params.worktree.workdir}\nBranch: ${params.worktree.branch_name}`
            : null,
        ].filter((line): line is string => Boolean(line))
      : [
          identity,
          "You are running in an isolated read-only context.",
          "Complete only the assigned agent job and report concise findings back to the parent agent.",
          "Do not address the end user directly. Do not ask follow-up questions. Do not claim to have edited files or run shell commands.",
          "You may inspect the workspace with the read/search/image tools available to you and use enabled MCP business tools when available. You cannot write files, delete files, run shell commands, manage settings, manage MCP server configuration, manage cron tasks, or spawn more subagents.",
          params.messageBusEnabled
            ? "Use SendMessage for cross-agent messages, decisions, and questions. Do not use workspace files as a mailbox. Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary."
            : "Use your final report as the communication channel to the parent agent. Do not use workspace files as a mailbox.",
        ];

  lines.push(
    [
      "Final report format:",
      "- Result: one or two sentences answering the delegated agent request.",
      params.task.mode === "worktree"
        ? "- Changes: files modified/created/deleted, commands/tests run, and any remaining work."
        : "- Evidence: concrete files, symbols, observations, or commands you inspected.",
      "- Risks: unknowns, assumptions, or follow-up checks if any.",
    ].join("\n"),
  );

  return lines.join("\n\n");
}

function buildSubagentUserPrompt(params: {
  task: DelegateAgentInput;
  identity: SubagentIdentityRecord;
  messageBusSnapshot?: string;
  messageBusEnabled?: boolean;
}) {
  return [
    `Delegated agent name: ${params.identity.displayName}`,
    `Delegated agent id: ${params.identity.logicalAgentId}`,
    `Delegated agent role: ${params.identity.role}`,
    `Task intent: ${params.task.taskIntent}`,
    `Apply policy: ${params.task.applyPolicy}`,
    "",
    "Current task:",
    params.task.prompt,
    params.messageBusSnapshot ? ["", params.messageBusSnapshot].join("\n") : "",
    "",
    params.task.applyPolicy === "none"
      ? params.messageBusEnabled
        ? "Do not create or modify workspace files for communication. Use SendMessage for cross-agent communication and return your completion summary in the final report. Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary."
        : "Do not create or modify workspace files for communication. Return your answer in the final report."
      : "",
    "Return only the final report for the parent agent.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildSubagentContext(params: {
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity: SubagentIdentityRecord;
  worktree?: DelegateWorktreeInfo;
  tools: Tool[];
  agentIndex?: number;
  agentTotal?: number;
  messageBusSnapshot?: string;
  messageBusEnabled?: boolean;
}): Context {
  return {
    systemPrompt: buildSubagentSystemPrompt({
      task: params.task,
      template: params.template,
      identity: params.identity,
      worktree: params.worktree,
      agentIndex: params.agentIndex,
      agentTotal: params.agentTotal,
      messageBusEnabled: params.messageBusEnabled,
    }),
    messages: [
      {
        role: "user",
        content: buildSubagentUserPrompt({
          task: params.task,
          identity: params.identity,
          messageBusSnapshot: params.messageBusSnapshot,
          messageBusEnabled: params.messageBusEnabled,
        }),
        timestamp: Date.now(),
      },
    ],
    tools: params.tools,
  };
}

export function buildSubagentContinuationMessage(params: {
  task: DelegateAgentInput;
  identity: SubagentIdentityRecord;
  resumedFrom: SubagentRunSummary;
  messageBusSnapshot?: string;
  messageBusEnabled?: boolean;
}): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Continue your existing delegated agent session.",
          `Agent name: ${params.identity.displayName}`,
          `Stable id: ${params.identity.logicalAgentId}`,
          `Stable role: ${params.identity.role}`,
          `Previous run id: ${params.resumedFrom.id}`,
          `Previous mode: ${params.resumedFrom.mode}`,
          `Current mode: ${params.task.mode}`,
          params.resumedFrom.mode !== params.task.mode
            ? `Execution mode changed: ${params.resumedFrom.mode} -> ${params.task.mode}`
            : "",
          `Task intent: ${params.task.taskIntent}`,
          `Apply policy: ${params.task.applyPolicy}`,
          `Current continuation task: ${params.task.prompt}`,
          params.messageBusSnapshot ? `\n${params.messageBusSnapshot}` : "",
          "",
          params.messageBusEnabled
            ? "Use your established role, prior findings, current tool access, and SendMessage when cross-agent communication is needed. Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary. Return only your updated result, evidence, and risks."
            : "Use your established role, prior findings, and current tool access. Return only your updated result, evidence, and risks.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    timestamp: Date.now(),
  };
}

export function buildSubagentMessageBusUpdateMessage(snapshot: string): Message | null {
  const text = snapshot.trim();
  if (!text) return null;
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: ["LiveAgent Message Bus snapshot refreshed for this turn.", "", text].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };
}

export function appendSubagentMessageBusSnapshotToContext(
  context: Context,
  snapshot: string,
): Context {
  const message = buildSubagentMessageBusUpdateMessage(snapshot);
  if (!message) return context;
  return {
    ...context,
    messages: [...context.messages, message],
  };
}
