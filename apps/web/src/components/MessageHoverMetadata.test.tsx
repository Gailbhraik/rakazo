import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageHoverMetadata } from "./MessageHoverMetadata";

describe("MessageHoverMetadata", () => {
  it("places bot actions to the right of the bubble", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain('data-testid="message-hover-rail"');
    expect(html).toContain("start-full");
    expect(html).toContain("top-1/2");
    expect(html).toContain("-translate-y-1/2");
    expect(html).not.toContain("bottom-0");
    expect(html).not.toContain("<time");
    expect(html).toContain("group-hover/message:opacity-100");
    expect(html).toContain("focus-within:opacity-100");
  });

  it("mirrors user actions to the left of the bubble", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata side="start">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain("end-full");
    expect(html).not.toContain("start-full");
  });

  it("pins the rail open while a nested menu is active", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata pinned side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain("pointer-events-auto opacity-100");
    expect(html).not.toContain("group-hover/message:opacity-100");
  });
});
