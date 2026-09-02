import { i18n } from "@lingui/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MessageHoverMetadata } from "./MessageHoverMetadata";

describe("MessageHoverMetadata", () => {
  afterEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("places bot actions to the right of the bubble, separate from the timestamp", () => {
    i18n.load("en", {});
    i18n.activate("en");

    const createdAt = new Date(2026, 7, 21, 18, 14).toISOString();
    const html = renderToStaticMarkup(
      <MessageHoverMetadata createdAt={createdAt} side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain('data-testid="message-hover-rail"');
    expect(html).toContain("start-full");
    expect(html).toContain("top-1/2");
    expect(html).toContain("-translate-y-1/2");
    expect(html).not.toContain("bottom-0");
    expect(html).toContain(
      `<time dateTime="${createdAt}" class="pointer-events-none absolute top-full mt-1 text-[11px] tabular-nums text-[#85858A] opacity-0 transition-opacity group-hover/message:opacity-100 start-0">6:14 PM</time>`,
    );
    expect(html.indexOf('data-testid="message-hover-rail"')).toBeLessThan(html.indexOf("<time"));
    expect(html).toContain("group-hover/message:opacity-100");
    expect(html).toContain("focus-within:opacity-100");
  });

  it("mirrors user actions to the left of the bubble", () => {
    i18n.load("en", {});
    i18n.activate("en");

    const html = renderToStaticMarkup(
      <MessageHoverMetadata createdAt={new Date().toISOString()} side="start">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain("end-full");
    expect(html).not.toContain("start-full");
    expect(html).toContain("end-0");
  });

  it("pins the rail open while a nested menu is active", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata createdAt={new Date().toISOString()} pinned side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    const railHtml = html.slice(0, html.indexOf("<time"));
    expect(railHtml).toContain("pointer-events-auto opacity-100");
    expect(railHtml).not.toContain("group-hover/message:opacity-100");
  });

  it("formats the displayed time with the active i18n locale", () => {
    i18n.load("de", {});
    i18n.activate("de");

    const createdAt = new Date(2026, 7, 21, 18, 14).toISOString();
    const html = renderToStaticMarkup(
      <MessageHoverMetadata createdAt={createdAt} side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain(`dateTime="${createdAt}"`);
    expect(html).toContain(">18:14</time>");
    expect(html).not.toContain("6:14 PM");
  });
});
