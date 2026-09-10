import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * Models a provider serves today but pi-ai's generated catalog does not know yet.
 *
 * The OpenRouter provider is static: its list comes from `OPENROUTER_MODELS`,
 * baked into the package, with no `fetchModels` overlay to refresh. A model
 * released after the last pi-ai publish is therefore unreachable until that
 * package ships again.
 *
 * The OpenAI-compatible provider is not a substitute: it carries no
 * `thinkingLevelMap` and no `compat.thinkingFormat`, so a reasoning model
 * selected through it loses its thinking levels and its reasoning text is
 * swallowed. These entries keep the full metadata instead.
 *
 * Remove an entry once pi-ai ships it — `registerExtraModels` skips ids the
 * catalog already has, so a stale entry is inert rather than harmful.
 */
const EXTRA_OPENROUTER_MODELS: Model<"openai-completions">[] = [
  {
    // OpenRouter live model metadata, 2026-09-10. Costs are standard per-million rates.
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek: DeepSeek V4.1 Flash",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  },
  {
    // Released after pi-ai 0.84.4. Metadata mirrors its 1.2 Contributor sibling,
    // whose pricing and context window OpenRouter reports as identical.
    id: "meta/muse-spark-1.3-contributor",
    name: "Meta: Muse Spark 1.3 Contributor",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  },
  {
    // Same release, without the data-contribution discount. The Contributor
    // endpoint trains on prompts, so an OpenRouter account that forbids such
    // providers gets "0 endpoints available" and a 404 for that id; this one
    // is the variant such an account can actually reach.
    id: "meta/muse-spark-1.3",
    name: "Meta: Muse Spark 1.3",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  },
];

/**
 * Republish a provider with extra models appended.
 *
 * `MutableModels` only upserts whole providers, so adding one model means
 * rebuilding the provider from its own auth, headers, and current list.
 */
function extendProvider(
  models: MutableModels,
  providerId: string,
  extras: readonly Model<"openai-completions">[],
): void {
  // Une collection réduite — un double de test qui n'expose que ce que le tour
  // sous test emploie — n'a aucun fournisseur à étendre. C'est le même cas de
  // figure qu'un fournisseur absent, et il se traite pareil : sans rien faire.
  if (typeof models.getProvider !== "function") return;
  const provider = models.getProvider(providerId);
  if (!provider) return;
  const current = provider.getModels();
  const missing = extras.filter((extra) => !current.some((model) => model.id === extra.id));
  if (!missing.length) return;
  models.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      auth: provider.auth,
      models: [...current, ...missing] as readonly Model<"openai-completions">[],
      api: openAICompletionsApi(),
    }),
  );
}

/** Add the catalog gap-fillers. No-op once pi-ai ships them. */
export function registerExtraModels(models: MutableModels): MutableModels {
  extendProvider(models, "openrouter", EXTRA_OPENROUTER_MODELS);
  return models;
}
