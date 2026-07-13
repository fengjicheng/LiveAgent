import { useLocale } from "../../../i18n";
import { VIBING_STATUS } from "../../../lib/chat/chatPageHelpers";
import { cn } from "../../../lib/shared/utils";

export function VibingText({ className }: { className?: string }) {
  return <AnimatedStatusText text={VIBING_STATUS} className={className} />;
}

export function CompactingText({ className }: { className?: string }) {
  const { t } = useLocale();
  return <AnimatedStatusText text={t("chat.compactingContext")} className={className} />;
}

function AnimatedStatusText(props: { text: string; className?: string }) {
  const { text, className } = props;
  return (
    <span className={cn("vibing-status", className)} aria-label={text}>
      {Array.from(text).map((char, idx) => (
        <span
          key={`${char}-${idx}`}
          aria-hidden="true"
          className="vibing-status-char"
          style={{ animationDelay: `${idx * 0.08}s` }}
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </span>
  );
}
