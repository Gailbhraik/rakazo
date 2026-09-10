export type RecentModel = {
  id: string;
  name: string;
  created: number;
  description: string;
  context: number | null;
  maxOutput: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  cachePrice: number | null;
  modalities: string[];
  tools: boolean;
  reasoning: boolean;
  variablePricing: boolean;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const amount = (value: unknown): number | null => {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** Upstream prices are USD per token, not per million tokens. Unknown prices stay unknown. */
export function normalizeRecentModels(payload: unknown): RecentModel[] {
  const data = record(payload).data;
  if (!Array.isArray(data)) throw new Error("Invalid catalog");
  return data
    .flatMap((value) => {
      const row = record(value),
        pricing = record(row.pricing),
        architecture = record(row.architecture),
        top = record(row.top_provider);
      if (
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.created !== "number" ||
        !Number.isFinite(row.created) ||
        row.created <= 0 ||
        row.created > 8_640_000_000_000
      )
        return [];
      const perMillion = (value: unknown) => {
        const parsed = amount(value);
        return parsed === null ? null : Number.isFinite(parsed * 1e6) ? parsed * 1e6 : null;
      };
      return [
        {
          id: row.id,
          name: row.name,
          created: row.created,
          description: typeof row.description === "string" ? row.description.slice(0, 1800) : "",
          context: amount(row.context_length),
          maxOutput: amount(top.max_completion_tokens),
          inputPrice: perMillion(pricing.prompt),
          outputPrice: perMillion(pricing.completion),
          cachePrice: perMillion(pricing.input_cache_read),
          modalities: strings(architecture.input_modalities),
          tools: strings(row.supported_parameters).includes("tools"),
          reasoning: strings(row.supported_parameters).includes("reasoning"),
          variablePricing: Array.isArray(pricing.overrides) && pricing.overrides.length > 0,
        },
      ];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .slice(0, 12);
}
type Snapshot = { models: RecentModel[]; fetchedAt: string; stale: boolean };
let cache: Snapshot | undefined;
let pending: Promise<Snapshot> | undefined;
/** Public metadata only; shared five-minute cache, with explicit stale state on outage. */
export async function recentOpenRouterModels(): Promise<Snapshot> {
  if (cache && Date.now() - Date.parse(cache.fetchedAt) < 300_000) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Catalog unavailable");
      const models = normalizeRecentModels(await response.json());
      if (!models.length) throw new Error("Empty catalog");
      cache = { models, fetchedAt: new Date().toISOString(), stale: false };
      return cache;
    } catch {
      if (cache) return { ...cache, stale: true };
      throw new Error("OpenRouter catalog unavailable");
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
