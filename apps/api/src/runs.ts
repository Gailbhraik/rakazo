import { type Actor, MessageBlock, type RunActivityRow } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, botMessageContext } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

export type RunsQuery = {
  filter: "active" | "recent";
  limit?: number;
  botId?: string;
  outcome?: "completed" | "failed" | "cancelled";
};

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  query: RunsQuery,
): Promise<{ runs: RunActivityRow[]; hasMore: boolean }> {
  const { filter, botId, outcome } = query;
  const limit = query.limit ?? RECENT_LIMIT;
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      ...(botId ? { botId } : {}),
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: outcome ? [outcome] : [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? limit + 1 : undefined,
  });

  const hasMore = filter === "recent" && rows.length > limit;
  if (hasMore) rows.pop();

  const runs = rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));

  return { runs, hasMore };
}
