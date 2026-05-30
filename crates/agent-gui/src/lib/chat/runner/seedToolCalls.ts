import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

const SEED_TOOL_CALL_DISPLAY_PATTERN = /<seed:tool_call>[\s\S]*?(?:<\/seed:tool_call>|$)/gi;
const FUNCTION_PATTERN = /<function\b([^>]*)>([\s\S]*?)(?:<\/function>|$)/i;
const PARAMETER_PATTERN =
  /<parameter\b([^>]*)>([\s\S]*?)(?:<\/parameter>|(?=<parameter\b|<\/function>|$))/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g;
const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;
const DSML_TOOL_CALL_DISPLAY_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>[\s\S]*?(?:<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>|$)`,
  "gi",
);
const DSML_INVOKE_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*invoke\b([^>]*)>([\s\S]*?)(?:<\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>|$)`,
  "gi",
);
const DSML_PARAMETER_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*parameter\b([^>]*)>([\s\S]*?)(?:<\/\s*${DSML_TAG_PREFIX}\s*parameter\s*>|(?=<\s*${DSML_TAG_PREFIX}\s*parameter\b|<\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>|$))`,
  "gi",
);

function parseAttributes(raw: string) {
  const attributes = new Map<string, string>();
  let match: RegExpExecArray | null = null;
  ATTRIBUTE_PATTERN.lastIndex = 0;
  while ((match = ATTRIBUTE_PATTERN.exec(raw)) !== null) {
    const key = match[1]?.trim().toLowerCase();
    if (!key) {
      continue;
    }
    attributes.set(key, decodeXmlEntities(match[2] ?? ""));
  }
  return attributes;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanRecoveredText(value: string) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableStringifyComparable(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyComparable(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyComparable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function coerceSeedParameterValue(value: string, attributes: Map<string, string>) {
  const decoded = decodeXmlEntities(value).trim();
  if ((attributes.get("string") ?? "").toLowerCase() === "true") {
    return decoded;
  }
  if (/^-?\d+$/.test(decoded)) {
    return Number(decoded);
  }
  if (/^-?\d+\.\d+$/.test(decoded)) {
    return Number(decoded);
  }
  if (/^(true|false)$/i.test(decoded)) {
    return decoded.toLowerCase() === "true";
  }
  if (/^null$/i.test(decoded)) {
    return null;
  }
  if (/^[[{][\s\S]*[\]}]$/.test(decoded)) {
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function parseSeedToolCallMarkup(markup: string): ToolCall | null {
  const functionMatch = FUNCTION_PATTERN.exec(markup);
  if (!functionMatch) {
    return null;
  }

  const functionAttributes = parseAttributes(functionMatch[1] ?? "");
  const toolName = functionAttributes.get("name")?.trim() ?? "";
  if (!toolName) {
    return null;
  }

  const args: Record<string, unknown> = {};
  const paramsBody = functionMatch[2] ?? "";
  let paramMatch: RegExpExecArray | null = null;
  PARAMETER_PATTERN.lastIndex = 0;
  while ((paramMatch = PARAMETER_PATTERN.exec(paramsBody)) !== null) {
    const paramAttributes = parseAttributes(paramMatch[1] ?? "");
    const paramName = paramAttributes.get("name")?.trim() ?? "";
    if (!paramName) {
      continue;
    }
    args[paramName] = coerceSeedParameterValue(paramMatch[2] ?? "", paramAttributes);
  }

  return {
    type: "toolCall",
    id: `seed-tool-call-${crypto.randomUUID()}`,
    name: toolName,
    arguments: args,
  };
}

function parseDsmlToolCallMarkup(markup: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let invokeMatch: RegExpExecArray | null = null;
  DSML_INVOKE_PATTERN.lastIndex = 0;

  while ((invokeMatch = DSML_INVOKE_PATTERN.exec(markup)) !== null) {
    const invokeAttributes = parseAttributes(invokeMatch[1] ?? "");
    const toolName = invokeAttributes.get("name")?.trim() ?? "";
    if (!toolName) {
      continue;
    }

    const args: Record<string, unknown> = {};
    const paramsBody = invokeMatch[2] ?? "";
    let paramMatch: RegExpExecArray | null = null;
    DSML_PARAMETER_PATTERN.lastIndex = 0;
    while ((paramMatch = DSML_PARAMETER_PATTERN.exec(paramsBody)) !== null) {
      const paramAttributes = parseAttributes(paramMatch[1] ?? "");
      const paramName = paramAttributes.get("name")?.trim() ?? "";
      if (!paramName) {
        continue;
      }
      args[paramName] = coerceSeedParameterValue(paramMatch[2] ?? "", paramAttributes);
    }

    toolCalls.push({
      type: "toolCall",
      id: `dsml-tool-call-${crypto.randomUUID()}`,
      name: toolName,
      arguments: args,
    });
  }

  return toolCalls;
}

function hasRecoverableToolCallMarkup(text: string) {
  return (
    text.includes("<seed:tool_call>") || (text.includes("DSML") && text.includes("tool_calls"))
  );
}

function recoverToolCallsFromBlockText(text: string) {
  if (!hasRecoverableToolCallMarkup(text)) {
    return {
      cleanedText: text,
      toolCalls: [] as ToolCall[],
    };
  }
  const toolCalls: ToolCall[] = [];
  let cleanedText = text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, (markup) => {
    const toolCall = parseSeedToolCallMarkup(markup);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return "";
  });
  cleanedText = cleanedText.replace(DSML_TOOL_CALL_DISPLAY_PATTERN, (markup) => {
    toolCalls.push(...parseDsmlToolCallMarkup(markup));
    return "";
  });

  return {
    cleanedText: cleanRecoveredText(cleanedText),
    toolCalls,
  };
}

export function stripSeedToolCallMarkup(text: string) {
  if (!hasRecoverableToolCallMarkup(text)) {
    return text;
  }
  return cleanRecoveredText(
    text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, "").replace(DSML_TOOL_CALL_DISPLAY_PATTERN, ""),
  );
}

export function recoverAssistantSeedToolCalls(
  assistant: AssistantMessage,
): { assistant: AssistantMessage; toolCalls: ToolCall[] } | null {
  const existingStructuredToolCalls = assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  const recoveredToolCalls: ToolCall[] = [];
  const nextContent: AssistantMessage["content"] = [];
  const seenComparableToolCalls = new Set(
    existingStructuredToolCalls.map(
      (toolCall) => `${toolCall.name}:${stableStringifyComparable(toolCall.arguments ?? {})}`,
    ),
  );
  let changed = false;

  for (const block of assistant.content) {
    if (block.type === "thinking") {
      const recovered = recoverToolCallsFromBlockText(block.thinking);
      if (recovered.cleanedText !== block.thinking) {
        changed = true;
      }
      if (recovered.cleanedText !== "") {
        nextContent.push({
          ...block,
          thinking: recovered.cleanedText,
        });
      }
      for (const toolCall of recovered.toolCalls) {
        const comparable = `${toolCall.name}:${stableStringifyComparable(toolCall.arguments ?? {})}`;
        if (seenComparableToolCalls.has(comparable)) {
          continue;
        }
        seenComparableToolCalls.add(comparable);
        nextContent.push(toolCall);
        recoveredToolCalls.push(toolCall);
        changed = true;
      }
      continue;
    }

    if (block.type === "text") {
      const recovered = recoverToolCallsFromBlockText(block.text);
      if (recovered.cleanedText !== block.text) {
        changed = true;
      }
      if (recovered.cleanedText !== "") {
        nextContent.push({
          ...block,
          text: recovered.cleanedText,
        });
      }
      for (const toolCall of recovered.toolCalls) {
        const comparable = `${toolCall.name}:${stableStringifyComparable(toolCall.arguments ?? {})}`;
        if (seenComparableToolCalls.has(comparable)) {
          continue;
        }
        seenComparableToolCalls.add(comparable);
        nextContent.push(toolCall);
        recoveredToolCalls.push(toolCall);
        changed = true;
      }
      continue;
    }

    nextContent.push(block);
  }

  if (!changed) {
    return null;
  }

  return {
    assistant: {
      ...assistant,
      content: nextContent,
      stopReason: recoveredToolCalls.length > 0 ? "toolUse" : assistant.stopReason,
    },
    toolCalls: recoveredToolCalls,
  };
}
