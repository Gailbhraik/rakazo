import type { ReactNode } from "react";

/** Side of the bubble that hosts the hover icon rail (Grok Bot geometry). */
export type MessageHoverSide = "start" | "end";

/**
 * Hover chrome for a chat bubble: muted outline icons sit flush beside the
 * bubble (vertically centered), not under it and not overlaid on the text.
 * No timestamp here. Time, if shown, lives in the More menu.
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
        // A few pixels off the bubble edge (Grok Bot), not a reserved column.
        side === "end" ? "start-full ms-1" : "end-full me-1"
      }`}
    >
      {children}
    </div>
  );
}
