import type { ReactNode } from "react";

/** Side of the bubble that hosts the hover icon rail (Grok Bot geometry). */
export type MessageHoverSide = "start" | "end";

/**
 * Hover chrome for a chat bubble: outline action icons sit beside the bubble
 * (vertically centered), not under it and not overlaid on the text. Timestamp
 * stays out of this rail so it cannot form a metadata strip under the bubble.
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
