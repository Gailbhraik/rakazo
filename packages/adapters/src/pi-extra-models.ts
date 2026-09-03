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
