import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  appendSubagentMessage,
  type SubagentHistoryRecorder,
  type SubagentMessageChannel,
  type SubagentMessageRecord,
} from "../../chat/subagent/subagentHistory";
import {
  SUBAGENT_BROADCAST_RECIPIENT,
  SUBAGENT_PARENT_AGENT_ID,
} from "../../chat/subagent/subagentMessageBus";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "../builtinTypes";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

const CHANNELS = new Set<SubagentMessageChannel>(["direct", "shared", "decision", "question"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecipient(value: unknown) {
  const raw = asString(value);
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "all" || lowered === "broadcast" || lowered === "everyone") {
    return SUBAGENT_BROADCAST_RECIPIENT;
  }
  if (lowered === "parent" || lowered === "supervisor" || lowered === "main") {
    return SUBAGENT_PARENT_AGENT_ID;
  }
  return raw;
}

function normalizeChannel(value: unknown, recipientAgentId: string): SubagentMessageChannel {
  const raw = asString(value) as SubagentMessageChannel;
  if (recipientAgentId === SUBAGENT_BROADCAST_RECIPIENT) {
    if (!raw || raw === "direct") return "shared";
    if (CHANNELS.has(raw)) return raw;
    return "shared";
  }
  if (raw === "shared") return "direct";
  if (CHANNELS.has(raw)) return raw;
  return "direct";
}

function displayRecipient(recipientAgentId: string) {
  if (recipientAgentId === SUBAGENT_PARENT_AGENT_ID) return "parent";
  if (recipientAgentId === SUBAGENT_BROADCAST_RECIPIENT) return "all agents";
  return recipientAgentId;
}

function buildDetails(record: SubagentMessageRecord) {
  return {
    kind: "subagent_message",
    parentConversationId: record.parentConversationId,
    seq: record.seq,
    senderAgentId: record.senderAgentId,
    senderDisplayName: record.senderDisplayName,
    recipientAgentId: record.recipientAgentId,
    recipientDisplayName: record.recipientDisplayName,
    channel: record.channel,
    subject: record.subject,
    sourceRunId: record.sourceRunId,
    sourceToolCallId: record.sourceToolCallId,
    bodyPreview:
      record.bodyMarkdown.length > 800
        ? `${record.bodyMarkdown.slice(0, 800)}...`
        : record.bodyMarkdown,
  };
}

export function createSubagentMessageTools(params: {
  parentConversationId?: string;
  currentAgentId: string;
  currentAgentName?: string;
  currentRunId?: string;
  subagentHistory?: SubagentHistoryRecorder;
}): BuiltinToolBundle {
  const toolSendMessage: Tool = {
    name: SEND_MESSAGE_TOOL_NAME,
    description: [
      "Send a Markdown message through the LiveAgent Message Bus to the parent agent, all agents, or one stable delegated-agent id.",
      "Use to=parent for the main agent, to=* for a shared broadcast, or to=<stable_agent_id> for a direct inbox message.",
      "Messages sent to parent are private to the parent. If other agents need to read the report, send a concise Markdown copy or summary to to=*.",
      "Visibility is controlled by to: channel=shared defaults to to=* only when to is omitted; explicit parent or stable-agent recipients remain private.",
      "Use channel=question for questions that need a reply and channel=decision for durable shared decisions. The message body must be concise Markdown.",
      "This tool records the message for delivery at the next model turn boundary; it does not wake idle agents immediately.",
    ].join("\n"),
    parameters: Type.Object(
      {
        to: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Recipient: parent, *, or a stable delegated-agent id such as player1. Optional only when channel=shared; then it defaults to *.",
          }),
        ),
        message: Type.String({
          minLength: 1,
          description: "Markdown message body to deliver.",
        }),
        channel: Type.Optional(
          Type.Union(
            [
              Type.Literal("direct"),
              Type.Literal("shared"),
              Type.Literal("decision"),
              Type.Literal("question"),
            ],
            {
              description: "Optional bus channel. Defaults to direct, or shared when to=*.",
            },
          ),
        ),
        subject: Type.Optional(
          Type.String({
            description: "Short optional subject line.",
          }),
        ),
        summary: Type.Optional(
          Type.String({
            description: "Optional short summary. Used as subject when subject is omitted.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (toolCall.name !== SEND_MESSAGE_TOOL_NAME) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const parentConversationId = params.parentConversationId?.trim();
    const senderAgentId = params.currentAgentId.trim();
    if (!parentConversationId || !senderAgentId) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: "SendMessage is unavailable because the current conversation or agent identity is missing.",
          },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const args = asRecord(toolCall.arguments);
    const rawChannel = asString(args.channel).toLowerCase();
    const recipientAgentId =
      normalizeRecipient(args.to) || (rawChannel === "shared" ? SUBAGENT_BROADCAST_RECIPIENT : "");
    const bodyMarkdown = asString(args.message);
    if (!recipientAgentId || !bodyMarkdown) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text:
              rawChannel === "shared"
                ? "SendMessage requires a non-empty message field."
                : "SendMessage requires non-empty to and message fields.",
          },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const channel = normalizeChannel(rawChannel, recipientAgentId);
    const subject = asString(args.subject) || asString(args.summary) || undefined;
    const append = params.subagentHistory?.appendMessage ?? appendSubagentMessage;
    const record = await append({
      parentConversationId,
      senderAgentId,
      senderDisplayName: params.currentAgentName?.trim() || undefined,
      recipientAgentId,
      recipientDisplayName:
        recipientAgentId === SUBAGENT_PARENT_AGENT_ID
          ? "Parent Agent"
          : recipientAgentId === SUBAGENT_BROADCAST_RECIPIENT
            ? "All Agents"
            : undefined,
      channel,
      subject,
      bodyMarkdown,
      sourceRunId: params.currentRunId,
      sourceToolCallId: toolCall.id,
      createdAt: now,
    });

    if (!record) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "SendMessage did not persist a message." }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: [
            `Message sent to ${displayRecipient(record.recipientAgentId)} via LiveAgent Message Bus.`,
            `seq=${record.seq}`,
            `channel=${record.channel}`,
          ].join("\n"),
        },
      ],
      details: buildDetails(record),
      isError: false,
      timestamp: now,
    };
  }

  return {
    groupId: "delegate",
    tools: [toolSendMessage],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        SEND_MESSAGE_TOOL_NAME,
        {
          groupId: "delegate",
          kind: "subagent_message",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
