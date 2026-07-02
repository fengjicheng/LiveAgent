import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const historySync = loader.loadModule("src/lib/historySync.ts");
const chatUi = loader.loadModule("src/lib/chatUi.ts");
const transcriptStoreModule = loader.loadModule("src/lib/chat/transcript/transcriptStore.ts");
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { buildRowsFromEntries } = loader.loadModule("src/lib/chat/transcript/rows.ts");
const historyShare = loader.loadModule("src/lib/historyShare.ts");
const requestContextSanitizer = loader.loadModule("src/lib/chat/requestContextSanitizer.ts");
const conversationState = loader.loadModule("src/lib/chat/conversationState.ts");

// Live-stream reducer harness: the createTurn/applyEventToTurn pair replaces
// the old flat pushChatEvent pipeline — one Turn holds a single run's entries.
function reduceTurnEvents(events) {
  let turn = createTurn({ key: "req:test", runId: "run-test" });
  for (const event of events) {
    turn = applyEventToTurn(turn, event);
  }
  return turn;
}

function findAssistantRow(rows) {
  return rows.find((row) => row.kind === "assistant");
}

test("history share helpers parse and build share URLs", () => {
  assert.equal(historyShare.parseHistoryShareToken("/share/abc123"), "abc123");
  assert.equal(historyShare.parseHistoryShareToken("/share/abc%20123"), "abc 123");
  assert.equal(historyShare.parseHistoryShareToken("/chat/abc123"), null);
  assert.equal(historyShare.parseHistoryShareToken("/share/abc/extra"), null);
  assert.equal(
    historyShare.buildHistoryShareUrl("abc123", "https://gateway.example/"),
    "https://gateway.example/share/abc123",
  );
});

test("history share timestamps accept seconds milliseconds and microseconds", () => {
  const timestampMs = Date.UTC(2026, 4, 13, 12, 34, 0);

  assert.equal(
    historyShare.normalizeHistoryTimestampMs(Math.floor(timestampMs / 1000)),
    timestampMs,
  );
  assert.equal(historyShare.normalizeHistoryTimestampMs(timestampMs), timestampMs);
  assert.equal(historyShare.normalizeHistoryTimestampMs(timestampMs * 1000), timestampMs);
  assert.equal(historyShare.normalizeHistoryTimestampMs(0), null);

  const formatted = historyShare.formatSharedHistoryTimestamp(timestampMs);
  assert.match(formatted, /2026/);
  assert.doesNotMatch(formatted, /58331/);
});

test("fetchSharedHistory reads public share details that parse into transcript entries", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/public/history-shares/share-token");
    assert.equal(options.credentials, "omit");
    return {
      ok: true,
      async json() {
        return {
          conversation_id: "conversation-1",
          messages_json: JSON.stringify([{ role: "user", content: "hello shared" }]),
          total_message_count: 1,
          redact_tool_content: true,
          conversation: {
            id: "conversation-1",
            title: "Shared",
            created_at: 1,
            updated_at: 2,
            message_count: 1,
          },
        };
      },
    };
  };

  try {
    const detail = await historyShare.fetchSharedHistory("share-token");
    const entries = chatUi.parseHistoryMessagesJson(detail.messages_json);
    assert.equal(detail.conversation_id, "conversation-1");
    assert.equal(detail.redact_tool_content, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "user");
    assert.equal(entries[0].text, "hello shared");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("applyGatewayHistoryEvent upserts newest summaries and removes deleted conversations", () => {
  const existing = [
    { id: "one", title: "One", created_at: 1, updated_at: 1, message_count: 1 },
    { id: "two", title: "Two", created_at: 2, updated_at: 2, message_count: 2 },
  ];

  const upserted = historySync.applyGatewayHistoryEvent(existing, {
    kind: "upsert",
    conversation_id: "two",
    conversation: { id: "two", title: "Updated", created_at: 2, updated_at: 3, message_count: 3 },
  });
  assert.deepEqual(upserted.map((item) => item.id), ["two", "one"]);
  assert.equal(upserted[0].title, "Updated");

  const deleted = historySync.applyGatewayHistoryEvent(upserted, {
    kind: "delete",
    conversation_id: "two",
  });
  assert.deepEqual(deleted.map((item) => item.id), ["one"]);
});

test("applyGatewayHistoryEvent sorts pinned conversations before recent conversations", () => {
  const existing = [
    { id: "older", title: "Older", created_at: 1, updated_at: 1, message_count: 1 },
    { id: "newer", title: "Newer", created_at: 2, updated_at: 2, message_count: 2 },
  ];

  const pinned = historySync.applyGatewayHistoryEvent(existing, {
    kind: "upsert",
    conversation_id: "older",
    conversation: {
      id: "older",
      title: "Older",
      created_at: 1,
      updated_at: 1,
      message_count: 1,
      is_pinned: true,
      pinned_at: 3,
    },
  });
  assert.deepEqual(pinned.map((item) => item.id), ["older", "newer"]);

  const unpinned = historySync.applyGatewayHistoryEvent(pinned, {
    kind: "upsert",
    conversation_id: "older",
    conversation: {
      id: "older",
      title: "Older",
      created_at: 1,
      updated_at: 1,
      message_count: 1,
      is_pinned: false,
      pinned_at: 0,
    },
  });
  assert.deepEqual(unpinned.map((item) => item.id), ["newer", "older"]);
});

test("applyGatewayHistoryEvent preserves share state when partial summaries arrive", () => {
  const existing = [
    {
      id: "shared",
      title: "Shared",
      created_at: 1,
      updated_at: 1,
      message_count: 1,
      is_shared: true,
    },
  ];

  const renamed = historySync.applyGatewayHistoryEvent(existing, {
    kind: "upsert",
    conversation_id: "shared",
    conversation: {
      id: "shared",
      title: "Renamed",
      created_at: 1,
      updated_at: 2,
      message_count: 1,
    },
  });

  assert.equal(renamed[0].title, "Renamed");
  assert.equal(renamed[0].is_shared, true);

  const disabled = historySync.applyGatewayHistoryEvent(renamed, {
    kind: "upsert",
    conversation_id: "shared",
    conversation: {
      id: "shared",
      title: "Renamed",
      created_at: 1,
      updated_at: 3,
      message_count: 1,
      is_shared: false,
    },
  });

  assert.equal(disabled[0].is_shared, false);
});

test("upsertConversationSummary keeps existing title when partial summary title is blank", () => {
  const existing = [
    {
      id: "conversation-1",
      title: "Existing title",
      created_at: 1,
      updated_at: 10,
      message_count: 4,
      provider_id: "codex",
      model: "gpt-5.2",
      session_id: "session-1",
      cwd: "/workspace",
    },
  ];

  const updated = historySync.upsertConversationSummary(existing, {
    id: "conversation-1",
    title: "",
    created_at: 1,
    updated_at: 11,
    message_count: 1,
    provider_id: "",
    model: "",
    session_id: "",
    cwd: "",
  });

  assert.equal(updated[0].title, "Existing title");
  assert.equal(updated[0].provider_id, "codex");
  assert.equal(updated[0].model, "gpt-5.2");
  assert.equal(updated[0].session_id, "session-1");
  assert.equal(updated[0].cwd, "/workspace");
  assert.equal(updated[0].updated_at, 11);
  assert.equal(updated[0].message_count, 1);
});

test("upsertConversationSummary can update titles without changing list position", () => {
  const existing = [
    {
      id: "newer",
      title: "Newer",
      created_at: 1,
      updated_at: 300,
      message_count: 4,
    },
    {
      id: "conversation-1",
      title: "1234567890",
      created_at: 1,
      updated_at: 100,
      message_count: 1,
    },
  ];

  const titleOnly = historySync.upsertConversationSummary(
    existing,
    {
      id: "conversation-1",
      title: "Generated title",
      created_at: 1,
      updated_at: 400,
      message_count: 1,
    },
    { preserveExistingUpdatedAt: true },
  );

  assert.deepEqual(titleOnly.map((item) => item.id), ["newer", "conversation-1"]);
  assert.equal(titleOnly[1].title, "Generated title");
  assert.equal(titleOnly[1].updated_at, 100);

  const recencyUpdate = historySync.upsertConversationSummary(existing, {
    id: "conversation-1",
    title: "Generated title",
    created_at: 1,
    updated_at: 400,
    message_count: 1,
  });

  assert.deepEqual(recencyUpdate.map((item) => item.id), ["conversation-1", "newer"]);
  assert.equal(recencyUpdate[0].updated_at, 400);
});

test("reconcileConversationSummaries keeps optimistic titles during protected refreshes", () => {
  const existing = [
    {
      id: "conversation-1",
      title: "1234567890",
      created_at: 100,
      updated_at: 100,
      message_count: 1,
    },
  ];

  const refreshed = historySync.reconcileConversationSummaries(
    existing,
    [
      {
        id: "conversation-1",
        title: "1234567890abcdef",
        created_at: 100,
        updated_at: 200,
        message_count: 2,
      },
    ],
    { preserveTitleConversationIds: ["conversation-1"] },
  );

  assert.equal(refreshed[0].title, "1234567890");
  assert.equal(refreshed[0].updated_at, 200);
  assert.equal(refreshed[0].message_count, 2);
});

test("reconcileConversationSummaries can keep protected rows in place during refreshes", () => {
  const existing = [
    {
      id: "newer",
      title: "Newer",
      created_at: 1,
      updated_at: 300,
      message_count: 4,
    },
    {
      id: "conversation-1",
      title: "1234567890",
      created_at: 1,
      updated_at: 100,
      message_count: 1,
    },
  ];

  const refreshed = historySync.reconcileConversationSummaries(
    existing,
    [
      {
        id: "conversation-1",
        title: "Backend title",
        created_at: 1,
        updated_at: 400,
        message_count: 2,
      },
      {
        id: "newer",
        title: "Newer",
        created_at: 1,
        updated_at: 300,
        message_count: 4,
      },
    ],
    {
      preserveTitleConversationIds: ["conversation-1"],
      preserveUpdatedAtConversationIds: ["conversation-1"],
    },
  );

  assert.deepEqual(refreshed.map((item) => item.id), ["newer", "conversation-1"]);
  assert.equal(refreshed[1].title, "1234567890");
  assert.equal(refreshed[1].updated_at, 100);
  assert.equal(refreshed[1].message_count, 2);
});

test("reconcileConversationSummaries retains running local rows missing from a list refresh", () => {
  const existing = [
    {
      id: "__local_draft__:1",
      title: "1234567890",
      created_at: 100,
      updated_at: 100,
      message_count: 1,
    },
  ];

  const refreshed = historySync.reconcileConversationSummaries(existing, [], {
    retainConversationIds: ["__local_draft__:1"],
  });

  assert.equal(refreshed[0], existing[0]);
});

test("applyGatewayHistoryEvent can protect optimistic titles from summary broadcasts", () => {
  const existing = [
    {
      id: "conversation-1",
      title: "1234567890",
      created_at: 100,
      updated_at: 100,
      message_count: 1,
    },
  ];
  const event = {
    kind: "upsert",
    conversation_id: "conversation-1",
    conversation: {
      id: "conversation-1",
      title: "1234567890abcdef",
      created_at: 100,
      updated_at: 200,
      message_count: 2,
    },
  };

  const protectedTitle = historySync.applyGatewayHistoryEvent(existing, event, {
    preserveTitleConversationIds: ["conversation-1"],
    preserveUpdatedAtConversationIds: ["conversation-1"],
  });
  assert.equal(protectedTitle[0].title, "1234567890");
  assert.equal(protectedTitle[0].updated_at, 100);

  const replacedTitle = historySync.applyGatewayHistoryEvent(existing, event);
  assert.equal(replacedTitle[0].title, "1234567890abcdef");
  assert.equal(replacedTitle[0].updated_at, 200);
});

test("parseHistoryMessagesJson preserves upload display text and checkpoint metadata", () => {
  const entries = chatUi.parseHistoryMessagesJson(JSON.stringify([
    {
      role: "user",
      content: "internal content with upload instruction",
      liveAgentDisplayContent: "please inspect notes",
      liveAgentAttachments: [
        {
          relativePath: "uploads/notes.txt",
          fileName: "notes.txt",
          kind: "text",
          sizeBytes: 42,
        },
      ],
      liveAgentHistoryRef: {
        segmentIndex: 1,
        messageIndex: 2,
        segmentId: "segment-1",
        messageId: "message-2",
        role: "user",
        contentHash: "hash-2",
      },
    },
    {
      role: "summary",
      id: "summary-1",
      content: "compressed facts",
      summaryMeta: {
        coveredMessageCount: 8,
        generatedBy: {
          providerId: "liveagent",
          model: "summary",
          promptVersion: "summary-v2",
        },
      },
    },
  ]));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "user");
  assert.equal(entries[0].text, "please inspect notes");
  assert.equal(entries[0].attachments[0].relativePath, "uploads/notes.txt");
  assert.deepEqual(entries[0].messageRef, {
    segmentIndex: 1,
    messageIndex: 2,
    segmentId: "segment-1",
    messageId: "message-2",
    role: "user",
    contentHash: "hash-2",
  });
  assert.equal(entries[1].kind, "checkpoint");
  assert.equal(entries[1].summaryId, "summary-1");
  assert.equal(entries[1].coveredMessageCount, 8);
});

test("parseHistoryMessagesJson preserves Image tool result image content", () => {
  const entries = chatUi.parseHistoryMessagesJson(JSON.stringify([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "image-call",
          name: "Image",
          arguments: { paths: ["uploads/001.jpg", "uploads/002.png"] },
        },
      ],
      provider: "codex",
      model: "gpt-test",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "image-call",
      toolName: "Image",
      content: [
        { type: "text", text: "Display images: 2" },
        { type: "image", mimeType: "image/jpeg", data: "abc123" },
        { type: "image", mimeType: "image/png", data: "def456" },
      ],
      details: {
        kind: "display_image",
        images: [
          {
            path: "uploads/001.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 12,
            mtimeMs: 10,
            contentHash: "hash-1",
          },
          {
            path: "uploads/002.png",
            mimeType: "image/png",
            sizeBytes: 34,
            mtimeMs: 11,
            contentHash: "hash-2",
          },
        ],
        path: "uploads/001.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 12,
        mtimeMs: 10,
        contentHash: "hash-1",
        loadMode: "inline",
      },
      isError: false,
      timestamp: 2,
    },
  ]));

  const toolCallEntry = entries.find((entry) => entry.kind === "tool_call");
  const toolResultEntry = entries.find((entry) => entry.kind === "tool_result");

  assert.ok(toolCallEntry);
  assert.equal(toolCallEntry.toolCall.name, "Image");
  assert.equal(toolCallEntry.summary, "Image paths=2 first=uploads/001.jpg");
  assert.ok(toolResultEntry);
  assert.equal(toolResultEntry.toolResult.details.kind, "display_image");
  assert.equal(toolResultEntry.toolResult.content[1].type, "image");
  assert.equal(toolResultEntry.toolResult.content[1].mimeType, "image/jpeg");
  assert.equal(toolResultEntry.toolResult.content[2].type, "image");
  assert.equal(toolResultEntry.toolResult.content[2].mimeType, "image/png");
});

test("parseHistoryMessagesJson preserves provider tool_use input arguments", () => {
  const entries = chatUi.parseHistoryMessagesJson(JSON.stringify([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "bash-call",
          name: "Bash",
          input: {
            command: "pnpm -C crates/agent-gateway/web build",
            cwd: "crates/agent-gateway/web",
            root: "workspace",
          },
        },
      ],
    },
  ]));

  const assistant = findAssistantRow(buildRowsFromEntries(entries, "history"));
  const toolBlock = assistant.rounds[0].blocks.find((block) => block.kind === "tool");

  assert.ok(toolBlock);
  assert.equal(toolBlock.item.toolCall.name, "Bash");
  assert.deepEqual(toolBlock.item.toolCall.arguments, {
    command: "pnpm -C crates/agent-gateway/web build",
    cwd: "crates/agent-gateway/web",
    root: "workspace",
  });
});

test("WebUI model request sanitizer textifies hosted search and drops aborted rounds", () => {
  const completedSearch = {
    type: "hostedSearch",
    id: "hosted-search-completed",
    provider: "claude_code",
    status: "completed",
    queries: ["LiveAgent DeepSeek web search"],
    sources: [{ url: "https://example.com/result", title: "Result" }],
  };
  const abortedSearch = {
    type: "hostedSearch",
    id: "hosted-search-aborted",
    provider: "claude_code",
    status: "completed",
    queries: ["aborted query"],
    sources: [{ url: "https://example.com/aborted" }],
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-aborted",
    toolName: "Read",
    content: [{ type: "text", text: "partial" }],
    isError: false,
    timestamp: 3,
  };

  const sanitized = requestContextSanitizer.sanitizeContextForModelRequest({
    messages: [
      { role: "user", content: "search", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "searching" }, completedSearch],
        provider: "anthropic",
        model: "deepseek-chat",
        api: "anthropic-messages",
        usage: { totalTokens: 1 },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [abortedSearch],
        provider: "anthropic",
        model: "deepseek-chat",
        api: "anthropic-messages",
        usage: { totalTokens: 1 },
        stopReason: "aborted",
        timestamp: 3,
      },
      toolResult,
    ],
  });

  assert.deepEqual(sanitized.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(
    sanitized.messages[1].content.map((block) => block.type),
    ["thinking", "text"],
  );
  assert.match(sanitized.messages[1].content[1].text, /Provider-hosted web search completed/);
  assert.match(sanitized.messages[1].content[1].text, /https:\/\/example\.com\/result/);
  assert.doesNotMatch(JSON.stringify(sanitized.messages), /hosted-search-aborted/);

  const state = conversationState.createConversationStateFromContext({
    messages: [
      { role: "user", content: "search", timestamp: 1 },
      {
        role: "assistant",
        content: [abortedSearch],
        provider: "anthropic",
        model: "deepseek-chat",
        api: "anthropic-messages",
        usage: { totalTokens: 1 },
        stopReason: "aborted",
        timestamp: 2,
      },
      toolResult,
      { role: "user", content: "continue", timestamp: 4 },
    ],
  });
  assert.deepEqual(
    conversationState.buildRequestContext(state).messages.map((message) => message.role),
    ["user", "user"],
  );
  assert.deepEqual(
    conversationState.buildRequestContext(state, { includeAbortedMessages: true }).messages.map(
      (message) => message.role,
    ),
    ["user", "assistant", "toolResult", "user"],
  );
});

test("WebUI transcript strips leaked DSML tool call markup from text and thinking", () => {
  const dsml = [
    "<||DSML|| tool_calls>",
    '<||DSML|| invoke name="builtin_web_search">',
    '<||DSML|| parameter name="query">LiveAgent DSML markup</||DSML|| parameter>',
    "</||DSML|| invoke>",
    "</||DSML|| tool_calls>",
  ].join("\n");
  const entries = chatUi.parseHistoryMessagesJson(JSON.stringify([
    {
      role: "assistant",
      content: [
        { type: "text", text: `before\n${dsml}\nafter` },
        { type: "thinking", thinking: `thinking\n${dsml}` },
      ],
    },
  ]));
  const assistant = findAssistantRow(buildRowsFromEntries(entries, "history"));
  const round = assistant.rounds[0];
  const allText = JSON.stringify(round.blocks);

  assert.match(allText, /before/);
  assert.match(allText, /after/);
  assert.match(allText, /thinking/);
  assert.doesNotMatch(allText, /DSML/);
  assert.doesNotMatch(allText, /builtin_web_search/);
});

test("WebUI transcript hides provider-native web_search tool traces when hosted search exists", () => {
  const webSearchCall = {
    type: "toolCall",
    id: "dsml-tool-call-webui-search",
    name: "web_search",
    arguments: { query: "LiveAgent DeepSeek webui search" },
  };
  const entries = chatUi.parseHistoryMessagesJson(JSON.stringify([
    { role: "user", content: "search" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "searching" },
        {
          type: "hostedSearch",
          id: "hosted-search-1",
          provider: "claude_code",
          status: "completed",
          queries: ["LiveAgent DeepSeek webui search"],
          sources: [{ url: "https://example.com/result", title: "Result" }],
        },
        webSearchCall,
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: webSearchCall.id,
      toolName: webSearchCall.name,
      content: [{ type: "text", text: "Tool web_search not found" }],
      details: { recoveredProviderNativeWebSearch: true },
      isError: true,
    },
  ]));

  const assistant = findAssistantRow(buildRowsFromEntries(entries, "history"));
  const round = assistant.rounds[0];

  assert.equal(round.blocks.some((block) => block.kind === "tool"), false);
  assert.equal(round.blocks.some((block) => block.kind === "hostedSearch"), true);
});

test("WebUI live transcript removes provider-native web_search when hosted search arrives later", () => {
  let turn = createTurn({ key: "req:test", runId: "run-test" });
  turn = applyEventToTurn(turn, {
    type: "tool_call",
    id: "call_00_webui_search",
    name: "web_search",
    arguments: { query: "LiveAgent DeepSeek live search" },
    round: 1,
  });

  let assistant = findAssistantRow(buildRowsFromEntries(turn.entries, "stream"));
  assert.equal(assistant.rounds[0].blocks.some((block) => block.kind === "tool"), true);

  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "hosted-search-live",
    provider: "claude_code",
    status: "completed",
    queries: ["LiveAgent DeepSeek live search"],
    sources: [{ url: "https://example.com/live", title: "Live Result" }],
    round: 1,
  });

  assistant = findAssistantRow(buildRowsFromEntries(turn.entries, "stream"));
  const round = assistant.rounds[0];

  assert.equal(round.blocks.some((block) => block.kind === "tool"), false);
  assert.equal(round.blocks.some((block) => block.kind === "hostedSearch"), true);
  assert.deepEqual(round.runningToolCallIds, []);
});

test("WebUI live transcript hides recovered provider-native web_search results without hosted search", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "call_00_webui_recovered_search",
      name: "WebSearch",
      arguments: { query: "LiveAgent recovered search" },
      round: 1,
    },
    {
      type: "tool_result",
      id: "call_00_webui_recovered_search",
      name: "WebSearch",
      content: [{ type: "text", text: "Recovered provider-native web search." }],
      details: { recoveredProviderNativeWebSearch: true },
      isError: false,
      round: 1,
    },
  ]);

  // The recovered result hides the whole trace; with nothing else in the
  // round the content gate drops it entirely — no avatar-only assistant row
  // (stronger than the old "row without tool blocks" rendering).
  const rows = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(findAssistantRow(rows), undefined, "fully hidden trace renders no assistant row");
  assert.equal(rows.length, 0);
});

test("WebUI live transcript hides recovered DSML provider-native web_search calls immediately", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "dsml-tool-call-webui-live-search",
      name: "builtin_web_search",
      arguments: { query: "LiveAgent DSML hidden search" },
      round: 1,
    },
  ]);

  // The DSML-recovered call is hidden immediately; the content-less round is
  // dropped so no assistant row (avatar) can appear for it.
  const rows = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(findAssistantRow(rows), undefined, "fully hidden call renders no assistant row");
  assert.equal(rows.length, 0);
});

test("turn reducer appends streaming text, dedupes tool cards, and dedupes compaction checkpoints", () => {
  let turn = createTurn({ key: "req:test", runId: "run-test" });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "hello ",
    round: 1,
    provider: "codex",
    model: "gpt-test",
    usage: { totalTokens: 12 },
  });
  turn = applyEventToTurn(turn, { type: "token", text: "world", round: 1 });
  assert.equal(turn.entries.length, 1);
  assert.equal(turn.entries[0].kind, "assistant");
  assert.equal(turn.entries[0].text, "hello world");
  assert.equal(turn.entries[0].meta.usageTotalTokens, 12);

  const toolCall = { type: "tool_call", id: "call-1", name: "Read", arguments: { path: "README.md" }, round: 1 };
  turn = applyEventToTurn(turn, toolCall);
  turn = applyEventToTurn(turn, toolCall);
  assert.equal(turn.entries.filter((entry) => entry.kind === "tool_call").length, 1);

  const checkpoint = {
    type: "token",
    text: "compressed facts",
    checkpoint: {
      summaryId: "summary-1",
      coveredMessageCount: 5,
      generatedBy: { providerId: "liveagent", model: "summary" },
    },
  };
  turn = applyEventToTurn(turn, checkpoint);
  turn = applyEventToTurn(turn, checkpoint);
  assert.equal(turn.entries.filter((entry) => entry.kind === "checkpoint").length, 1);
});

test("turn reducer preserves tool call arguments from JSON string and input aliases", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "bash-call",
      name: "Bash",
      arguments: JSON.stringify({
        command: "echo gateway",
        cwd: "crates/agent-gateway",
        root: "workspace",
      }),
      round: 1,
    },
    {
      type: "tool_call",
      id: "read-call",
      name: "Read",
      input: {
        path: "README.md",
        root: "workspace",
      },
      round: 1,
    },
    {
      type: "tool_call",
      data: JSON.stringify({
        id: "glob-call",
        name: "Glob",
        args: {
          pattern: "**/*.ts",
          path: "src",
          root: "workspace",
        },
      }),
      round: 1,
    },
  ]);
  const entries = turn.entries;

  const bashCall = entries.find((entry) => entry.kind === "tool_call" && entry.toolCall.id === "bash-call");
  const readCall = entries.find((entry) => entry.kind === "tool_call" && entry.toolCall.id === "read-call");
  const globCall = entries.find((entry) => entry.kind === "tool_call" && entry.toolCall.id === "glob-call");
  const assistant = findAssistantRow(buildRowsFromEntries(entries, "stream"));
  const toolBlocks = assistant.rounds[0].blocks.filter((block) => block.kind === "tool");

  assert.ok(bashCall);
  assert.equal(bashCall.toolCall.arguments.command, "echo gateway");
  assert.match(bashCall.summary, /command=echo gateway/);
  assert.ok(readCall);
  assert.equal(readCall.toolCall.arguments.path, "README.md");
  assert.ok(globCall);
  assert.equal(globCall.toolCall.arguments.pattern, "**/*.ts");
  assert.equal(toolBlocks[0].item.toolCall.arguments.command, "echo gateway");
  assert.equal(toolBlocks[1].item.toolCall.arguments.path, "README.md");
  assert.equal(toolBlocks[2].item.toolCall.arguments.pattern, "**/*.ts");
});

test("turn reducer reconstructs a parameterized tool card from tool_result arguments", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_result",
      id: "bash-result-only",
      name: "Bash",
      arguments: {
        command: "printf live",
        cwd: "crates/agent-gateway",
        root: "workspace",
      },
      content: [{ type: "text", text: "live" }],
      isError: false,
      round: 1,
    },
  ]);
  const entries = turn.entries;

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "tool_call");
  assert.equal(entries[0].toolCall.arguments.command, "printf live");
  assert.equal(entries[1].kind, "tool_result");

  const assistant = findAssistantRow(buildRowsFromEntries(entries, "stream"));
  const toolBlock = assistant.rounds[0].blocks.find((block) => block.kind === "tool");

  assert.ok(toolBlock);
  assert.equal(toolBlock.item.toolCall.name, "Bash");
  assert.equal(toolBlock.item.toolCall.arguments.command, "printf live");
  assert.equal(toolBlock.item.toolResult.content[0].text, "live");
});

test("turn reducer does not duplicate tool cards when tool_call precedes parameterized tool_result", () => {
  const toolArguments = {
    command: "printf once",
    cwd: "crates/agent-gateway",
    root: "workspace",
  };
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "bash-no-duplicate",
      name: "Bash",
      arguments: toolArguments,
      round: 1,
    },
    {
      type: "tool_result",
      id: "bash-no-duplicate",
      name: "Bash",
      arguments: toolArguments,
      content: [{ type: "text", text: "once" }],
      isError: false,
      round: 1,
    },
  ]);
  const entries = turn.entries;

  assert.equal(entries.filter((entry) => entry.kind === "tool_call").length, 1);
  assert.equal(entries.filter((entry) => entry.kind === "tool_result").length, 1);

  const assistant = findAssistantRow(buildRowsFromEntries(entries, "stream"));
  const toolBlocks = assistant.rounds[0].blocks.filter((block) => block.kind === "tool");

  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].item.toolCall.arguments.command, "printf once");
  assert.equal(toolBlocks[0].item.toolResult.content[0].text, "once");
});

test("turn reducer upgrades an existing live tool card when execution start carries arguments", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "bash-late-args",
      name: "Bash",
      round: 1,
    },
    {
      type: "tool_call",
      id: "bash-late-args",
      name: "Bash",
      arguments: {
        command: "printf from-start",
        cwd: "crates/agent-gateway",
        root: "workspace",
      },
      round: 1,
    },
  ]);
  const entries = turn.entries;

  assert.equal(entries.filter((entry) => entry.kind === "tool_call").length, 1);
  assert.equal(entries[0].toolCall.arguments.command, "printf from-start");
  assert.match(entries[0].summary, /command=printf from-start/);
});

test("turn reducer upgrades an existing live tool card when tool_result carries arguments", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "bash-result-args",
      name: "Bash",
      round: 1,
    },
    {
      type: "tool_result",
      id: "bash-result-args",
      name: "Bash",
      arguments: {
        command: "printf from-result",
        cwd: "crates/agent-gateway",
        root: "workspace",
      },
      content: [{ type: "text", text: "from-result" }],
      isError: false,
      round: 1,
    },
  ]);
  const entries = turn.entries;

  assert.equal(entries.filter((entry) => entry.kind === "tool_call").length, 1);
  assert.equal(entries.filter((entry) => entry.kind === "tool_result").length, 1);
  assert.equal(entries[0].toolCall.arguments.command, "printf from-result");

  const assistant = findAssistantRow(buildRowsFromEntries(entries, "stream"));
  const toolBlock = assistant.rounds[0].blocks.find((block) => block.kind === "tool");

  assert.ok(toolBlock);
  assert.equal(toolBlock.item.toolCall.arguments.command, "printf from-result");
  assert.equal(toolBlock.item.toolResult.content[0].text, "from-result");
});

test("turn reducer keeps a deduped result while applying late result arguments", () => {
  const turn = reduceTurnEvents([
    {
      type: "tool_call",
      id: "bash-duplicate-result",
      name: "Bash",
      round: 1,
    },
    {
      type: "tool_result",
      id: "bash-duplicate-result",
      name: "Bash",
      content: [{ type: "text", text: "duplicate" }],
      isError: false,
      round: 1,
    },
    {
      type: "tool_result",
      id: "bash-duplicate-result",
      name: "Bash",
      arguments: {
        command: "printf duplicate",
        cwd: "crates/agent-gateway",
        root: "workspace",
      },
      content: [{ type: "text", text: "duplicate" }],
      isError: false,
      round: 1,
    },
  ]);
  const entries = turn.entries;

  assert.equal(entries.filter((entry) => entry.kind === "tool_call").length, 1);
  assert.equal(entries.filter((entry) => entry.kind === "tool_result").length, 1);
  assert.equal(entries[0].toolCall.arguments.command, "printf duplicate");
});

function findTreeNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findTreeNode(child, predicate);
      if (match) {
        return match;
      }
    }
    return null;
  }
  if (node == null || typeof node !== "object") {
    return null;
  }
  if (predicate(node)) {
    return node;
  }
  const children = node.props?.children;
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    const match = findTreeNode(child, predicate);
    if (match) {
      return match;
    }
  }
  return null;
}

test("formatConversationTitle falls back to stable labels", () => {
  assert.equal(chatUi.formatConversationTitle({ id: "abc", title: "  Named  " }), "Named");
  assert.equal(chatUi.formatConversationTitle(null, "conversation-abcdef"), "会话 conversa");
  assert.equal(chatUi.formatConversationTitle(null, ""), "新对话");
});

test("resolveConversationBrowserTitle uses project title for project-level empty selection", () => {
  assert.equal(
    chatUi.resolveConversationBrowserTitle({
      conversation: null,
      conversationId: "conversation-abcdef",
      projectName: "  Project Alpha  ",
      newConversationTitle: "LiveAgent",
    }),
    "Project Alpha",
  );
  assert.equal(
    chatUi.resolveConversationBrowserTitle({
      conversation: { id: "conversation-abcdef", title: "  Named  " },
      conversationId: "conversation-abcdef",
      projectName: "Project Alpha",
      newConversationTitle: "LiveAgent",
    }),
    "Named",
  );
  assert.equal(
    chatUi.resolveConversationBrowserTitle({
      conversation: null,
      conversationId: "__local_draft__:abc",
      projectName: "Project Alpha",
      isLocalDraftConversation: true,
      newConversationTitle: "LiveAgent",
    }),
    "LiveAgent",
  );
});

test("buildOptimisticConversationTitle uses the first ten characters of the first prompt paragraph", () => {
  assert.equal(
    chatUi.buildOptimisticConversationTitle("  12345 67890 abc\nstill first paragraph\n\nsecond"),
    "12345 6789",
  );
  assert.equal(
    chatUi.buildOptimisticConversationTitle("这是第一段提示词超过十个字\n\n第二段"),
    "这是第一段提示词超过",
  );
  assert.equal(chatUi.buildOptimisticConversationTitle("   \n\n  "), "新对话");
});

test("GatewayTranscript renders folded and live regions as slices of one row list", () => {
  const fakeReact = {
    createContext(defaultValue) {
      return { defaultValue };
    },
    memo(component) {
      return component;
    },
    useCallback(callback) {
      return callback;
    },
    useContext(context) {
      return context.defaultValue;
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) {
      return factory();
    },
    useRef(value) {
      return { current: value };
    },
    useState(initialValue) {
      const value = typeof initialValue === "function" ? initialValue() : initialValue;
      return [value, () => {}];
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
  const transcriptLoader = createWebModuleLoader({
    mocks: {
      react: fakeReact,
      "@tanstack/react-virtual": {
        useVirtualizer() {
          return {
            getTotalSize: () => 0,
            getVirtualItems: () => [],
            measureElement: () => {},
          };
        },
      },
      "@/components/Markdown": {
        Markdown(props) {
          return { type: "Markdown", props };
        },
      },
      "@/components/chat/ImagePreview": {
        ImagePreview(props) {
          return { type: "ImagePreview", props };
        },
      },
      "@/pages/chat/AssistantBubble": {
        AssistantAvatar() {
          return { type: "AssistantAvatar", props: {} };
        },
        AssistantBubble(props) {
          return { type: "AssistantBubble", props };
        },
        CompactingText(props) {
          return { type: "CompactingText", props };
        },
        VibingText(props) {
          return { type: "VibingText", props };
        },
      },
    },
  });
  const { GatewayTranscript } = transcriptLoader.loadModule("src/components/GatewayTranscript.tsx");

  globalThis.window = undefined;
  globalThis.document = { visibilityState: "visible" };

  // Folded rows come from parsed history; live rows are born from the
  // stream (a seeded prompt plus its streaming reply). Both regions come
  // from one store assembly: foldedRows + liveRows.
  const store = transcriptStoreModule.createTranscriptStore();
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "earlier question", attachments: [] },
      { id: "ht:hu:m1>0", kind: "assistant", text: "earlier answer", round: 1 },
    ],
    { mode: "replace" },
  );
  store.applyEvent({
    type: "user_message",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 1,
    message: "queued from gui",
  });
  store.applyEvent({
    type: "run_started",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 2,
  });
  store.applyEvent({
    type: "token",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 3,
    text: "reply",
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.foldedRows.length, 2, "history rows fold; the live exchange stays below");
  assert.deepEqual(
    [...snapshot.foldedRows, ...snapshot.liveRows].map((row) => row.kind),
    ["user", "assistant", "user", "assistant"],
  );

  const transcriptTree = GatewayTranscript({
    conversationId: "conversation-1",
    foldedRows: snapshot.foldedRows,
    liveRows: snapshot.liveRows,
    activeTurnKey: snapshot.activeTurnKey,
    isStreaming: true,
  });

  const foldedRegionNode = findTreeNode(
    transcriptTree,
    (node) =>
      typeof node.type === "function" &&
      Array.isArray(node.props?.rows) &&
      node.props?.conversationId === "conversation-1",
  );
  assert.ok(foldedRegionNode, "virtualized region receives the folded rows");
  assert.deepEqual(
    foldedRegionNode.props.rows.map((row) => row.key),
    snapshot.foldedRows.map((row) => row.key),
  );

  const liveRegionNode = findTreeNode(
    transcriptTree,
    (node) =>
      typeof node.type === "function" &&
      Array.isArray(node.props?.rows) &&
      node.props?.isAgentMode !== undefined,
  );
  assert.ok(liveRegionNode, "live region receives the rows past the fold boundary");
  assert.deepEqual(
    liveRegionNode.props.rows.map((row) => row.key),
    snapshot.liveRows.map((row) => row.key),
  );
  assert.deepEqual(
    liveRegionNode.props.rows.map((row) => row.kind),
    ["user", "assistant"],
  );

  const liveTree = liveRegionNode.type(liveRegionNode.props);
  assert.ok(
    findTreeNode(
      liveTree,
      (node) =>
        typeof node.props?.className === "string" &&
        node.props.className.includes("gateway-transcript-row-user"),
    ),
    "live user bubble renders before the live assistant output",
  );
  assert.ok(
    findTreeNode(
      liveTree,
      (node) => typeof node.type === "function" && node.props?.text === "queued from gui",
    ),
  );
  const assistantBubble = findTreeNode(
    liveTree,
    (node) => typeof node.type === "function" && node.props?.renderMode !== undefined,
  );
  assert.ok(assistantBubble, "live assistant bubble rendered");
  assert.equal(
    assistantBubble.props.renderMode,
    "streaming",
    "live-born rows keep the streaming render mode",
  );
});

test("transcript store history refresh stays quiet for identical content", () => {
  // The old pipeline kept a quiet refresh stable via text-hash dedup keys
  // (renamed incoming ids were re-mapped onto the rendered ones). The new
  // parser makes ids deterministic instead: reparsing the same persisted
  // JSON yields identical ids, so an idle "enrich" refresh with unchanged
  // content is a structural no-op — same snapshot, same row keys, and the
  // exchange still renders exactly once.
  globalThis.window = undefined;
  globalThis.document = { visibilityState: "visible" };
  const store = transcriptStoreModule.createTranscriptStore();

  const messagesJson = JSON.stringify([
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  const firstParse = chatUi.parseHistoryMessagesJson(messagesJson);
  store.applyHistorySnapshot(firstParse, { mode: "replace" });
  store.flush();
  const first = store.getSnapshot();
  assert.deepEqual(
    first.foldedRows.map((row) => row.kind),
    ["user", "assistant"],
  );
  assert.equal(first.liveRows.length, 0, "history renders in the folded region");

  const secondParse = chatUi.parseHistoryMessagesJson(messagesJson);
  assert.deepEqual(
    secondParse.map((entry) => entry.id),
    firstParse.map((entry) => entry.id),
    "reparsing the same JSON yields identical deterministic ids",
  );

  // Idle quiet refresh with identical content: nothing re-renders.
  store.applyHistorySnapshot(secondParse, { mode: "enrich" });
  store.flush();
  const second = store.getSnapshot();
  assert.equal(second, first, "identical content leaves the snapshot untouched");
  assert.deepEqual(
    second.foldedRows.map((row) => row.key),
    first.foldedRows.map((row) => row.key),
    "row keys are stable across the refresh",
  );
  assert.equal(
    [...second.foldedRows, ...second.liveRows].filter((row) => row.kind === "user").length,
    1,
    "the exchange renders exactly once (no duplicate prompt)",
  );
});
