import type { ProviderId } from "../settings";

export function providerSupportsNativeWebSearch(
  providerId: ProviderId,
  api: string | undefined,
  options?: {
    baseUrl?: string;
    modelId?: string;
  },
) {
  if (providerId === "codex" && api === "openai-completions") {
    if (!options?.baseUrl?.trim()) return false;
    if (isOfficialOpenAIBaseUrl(options.baseUrl)) {
      return supportsOpenAIChatCompletionsNativeWebSearchModel(options.modelId);
    }
    return true;
  }

  return (
    (providerId === "codex" && api === "openai-responses") ||
    (providerId === "claude_code" && api === "anthropic-messages") ||
    (providerId === "gemini" && api === "google-generative-ai")
  );
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function supportsOpenAIChatCompletionsNativeWebSearchModel(modelId: string | undefined) {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  return normalized.includes("search-preview");
}
