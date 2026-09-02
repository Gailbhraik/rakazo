import { i18n } from "@lingui/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MessageHoverMetadata, MessageHoverTimestamp } from "./MessageHoverMetadata";

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

describe("MessageHoverTimestamp", () => {
  afterEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("renders an in-flow quiet time under the bubble, not in the icon rail", () => {
    i18n.load("en", {});
    i18n.activate("en");

    const createdAt = new Date(2026, 7, 21, 18, 14).toISOString();
    const html = renderToStaticMarkup(<MessageHoverTimestamp createdAt={createdAt} side="end" />);

    expect(html).toContain('data-testid="message-hover-time"');
    expect(html).toContain("mt-1 block h-[14px]");
    expect(html).toContain("text-start");
    expect(html).not.toContain("absolute");
    expect(html).toContain(
      `<time dateTime="${createdAt}" data-testid="message-hover-time" class="mt-1 block h-[14px] text-[11px] leading-[14px] tabular-nums text-[#85858A] opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 text-start">6:14 PM</time>`,
    );
  });

  it("mirrors alignment for user bubbles", () => {
    const html = renderToStaticMarkup(
      <MessageHoverTimestamp createdAt={new Date().toISOString()} side="start" />,
    );
    expect(html).toContain("text-end");
    expect(html).not.toContain("text-start");
  });

  it("formats the displayed time with the active i18n locale", () => {
    i18n.load("de", {});
    i18n.activate("de");

    const createdAt = new Date(2026, 7, 21, 18, 14).toISOString();
    const html = renderToStaticMarkup(<MessageHoverTimestamp createdAt={createdAt} side="end" />);

    expect(html).toContain(`dateTime="${createdAt}"`);
    expect(html).toContain(">18:14</time>");
    expect(html).not.toContain("6:14 PM");
  });
});
