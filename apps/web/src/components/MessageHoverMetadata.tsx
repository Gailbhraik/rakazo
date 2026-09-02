import { i18n } from "@lingui/core";
import type { ReactNode } from "react";

/** Side of the bubble that hosts the hover icon rail (Grok Bot geometry). */
export type MessageHoverSide = "start" | "end";

/**
 * Hover chrome for a chat bubble: outline action icons sit beside the bubble
 * (vertically centered), not under it and not overlaid on the text.
 */
export function MessageHoverMetadata({
  side,
  pinned = false,
  children,
}: {
  side: MessageHoverSide;
  /** Keep the rail visible while a menu inside it is open. */
  pinned?: boolean;
  children: ReactNode;
}) {
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : "opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";

  return (
    <div
      data-testid="message-hover-rail"
      className={`pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity ${reveal} ${
        side === "end" ? "start-full ms-1.5" : "end-full me-1.5"
      }`}
    >
      {children}
    </div>
  );
}

/**
 * Quiet secondary timestamp under the bubble. In normal flow so it reserves a
 * slim line of height and cannot overlap the next transcript row. Not mixed
 * into the icon rail (that would recreate the #475 under-bubble pills strip).
 */
export function MessageHoverTimestamp({
  side,
  createdAt,
}: {
  side: MessageHoverSide;
  createdAt: string;
}) {
  return (
    <time
      dateTime={createdAt}
      data-testid="message-hover-time"
      className={`mt-1 block h-[14px] text-[11px] leading-[14px] tabular-nums text-[#85858A] opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 ${
        side === "end" ? "text-start" : "text-end"
      }`}
    >
      {new Date(createdAt).toLocaleTimeString(i18n.locale || "en", {
        hour: "numeric",
        minute: "2-digit",
      })}
    </time>
  );
}
