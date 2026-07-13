import { memo, useSyncExternalStore } from "react";

import { Markdown } from "../../../components/Markdown";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../../lib/chat/page/chatPageHelpers";
import {
  AssistantAvatar,
  AssistantBubble,
  CompactingText,
  VibingText,
} from "../components/AssistantBubble";
import { TypingDots } from "./TranscriptLoadingStates";
import type { TranscriptLiveStateProps } from "./transcriptTypes";

export const TranscriptLiveState = memo(function TranscriptLiveState(
  props: TranscriptLiveStateProps,
) {
  const {
    isSending,
    isAgentMode,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
  } = props;
  const liveState = useSyncExternalStore(
    liveTranscriptStore.subscribe,
    liveTranscriptStore.getSnapshot,
    liveTranscriptStore.getSnapshot,
  );
  const { draftAssistantText, liveRounds, toolStatus } = liveState;
  const displayedToolStatus = normalizeLiveToolStatus(toolStatus);

  if (!isSending) {
    return null;
  }

  if (liveRounds.length > 0) {
    return (
      <div className="flex justify-start">
        <AssistantBubble
          rounds={liveRounds}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          isLive
          toolStatus={displayedToolStatus}
          toolStatusVariant={isCompactionRunning ? "compaction" : "default"}
        />
      </div>
    );
  }

  if (isAgentMode) {
    return (
      <div className="flex justify-start">
        <div className="flex w-full max-w-full items-start gap-3">
          <AssistantAvatar />
          <div className="min-w-0 flex-1 pt-1">
            {isCompactionRunning ? (
              <div className="flex items-center py-1">
                <CompactingText className="text-sm font-medium text-muted-foreground" />
              </div>
            ) : displayedToolStatus === VIBING_STATUS ? (
              <div className="flex items-center py-1">
                <VibingText className="text-sm font-medium text-muted-foreground" />
              </div>
            ) : displayedToolStatus ? (
              <div className="py-1 text-sm text-muted-foreground">{displayedToolStatus}</div>
            ) : (
              <TypingDots />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="flex w-full max-w-full items-start gap-3">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 pt-0.5">
          {draftAssistantText ? (
            <Markdown
              content={draftAssistantText}
              className="font-openai-chat"
              renderMode="streaming"
              showCaret
            />
          ) : isCompactionRunning ? (
            <div className="flex items-center py-1">
              <CompactingText className="text-sm font-medium text-muted-foreground" />
            </div>
          ) : displayedToolStatus === VIBING_STATUS ? (
            <div className="flex items-center py-1">
              <VibingText className="text-sm font-medium text-muted-foreground" />
            </div>
          ) : displayedToolStatus ? (
            <div className="py-1 text-sm text-muted-foreground">{displayedToolStatus}</div>
          ) : (
            <TypingDots />
          )}
        </div>
      </div>
    </div>
  );
});
