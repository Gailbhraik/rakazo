export type DevItem = {
  id: string;
  kind: "task" | "bug" | "command";
  text: string;
  done: boolean;
  priority: "normal" | "high";
};
export type DevNotebook = { notes: string; items: DevItem[] };
export function parseNotebook(raw: string | null): DevNotebook {
  if (!raw) return { notes: "", items: [] };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid notebook");
  const data = value as DevNotebook;
  if (
    typeof data.notes !== "string" ||
    !Array.isArray(data.items) ||
    data.items.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        typeof item.done !== "boolean" ||
        !["task", "bug", "command"].includes(item.kind) ||
        !["normal", "high"].includes(item.priority),
    )
  )
    throw new Error("Invalid notebook");
  return { notes: data.notes, items: data.items };
}
export function notebookMarkdown(data: DevNotebook): string {
  return [
    "# Carnet de développement",
    "",
    data.notes,
    "",
    ...data.items.map((item) =>
      item.kind === "command"
        ? `### Commande\n\n\`\`\`\n${item.text}\n\`\`\`\n`
        : `- [${item.done ? "x" : " "}] ${item.kind === "bug" ? "BUG : " : ""}${item.priority === "high" ? "[Prioritaire] " : ""}${item.text}`,
    ),
  ].join("\n");
}
