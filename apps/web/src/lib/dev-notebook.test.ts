import { describe, expect, it } from "vitest";
import { notebookMarkdown, parseNotebook } from "./dev-notebook";

describe("development notebook", () => {
  it("starts empty and preserves saved records", () => {
    expect(parseNotebook(null)).toEqual({ notes: "", items: [] });
    const data = {
      notes: "Projet",
      items: [{ id: "a", kind: "bug", text: "Crash", done: false, priority: "high" }],
    };
    expect(parseNotebook(JSON.stringify(data))).toEqual(data);
  });
  it("rejects damaged storage instead of overwriting it", () => {
    for (const raw of ["{", "null", '{"notes":2,"items":[]}', '{"notes":"","items":[null]}'])
      expect(() => parseNotebook(raw)).toThrow();
  });
  it("exports statuses, priority and commands", () => {
    const output = notebookMarkdown({
      notes: "Repo",
      items: [
        { id: "a", kind: "bug", text: "Crash", done: true, priority: "high" },
        { id: "b", kind: "command", text: "npm test", done: false, priority: "normal" },
      ],
    });
    expect(output).toContain("[x] BUG : [Prioritaire] Crash");
    expect(output).toContain("```\nnpm test\n```");
  });
});
