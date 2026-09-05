import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerExtraModels } from "./pi-extra-models.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { registerOpenAiCompatibleCatalog } from "./pi-openai-compatible-provider.js";

export type ModelPricing = {
  /** Dollars par million de jetons d'entrée. */
  input: number;
  /** Dollars par million de jetons de sortie. */
  output: number;
};

let cache: Map<string, ModelPricing> | undefined;

function buildPricing(): Map<string, ModelPricing> {
  const models = registerExtraModels(
    registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels())),
  );
  const pricing = new Map<string, ModelPricing>();
  for (const provider of models.getProviders()) {
    for (const model of provider.getModels()) {
      const cost = model.cost;
      if (!cost) continue;
      pricing.set(`${provider.id}:${model.id}`, { input: cost.input, output: cost.output });
    }
  }
  return pricing;
}

/**
 * Tarif d'un modèle, tel que le catalogue l'annonce.
 *
 * Renvoie `undefined` pour un modèle inconnu du catalogue — un serveur
 * OpenAI-compatible, un modèle local, ou une entrée retirée depuis. L'appelant
 * doit alors afficher la consommation sans coût plutôt qu'un zéro, qui se
 * lirait comme « gratuit ».
 */
export function modelPricing(provider: string, modelId: string): ModelPricing | undefined {
  cache ??= buildPricing();
  return cache.get(`${provider}:${modelId}`);
}

/**
 * Coût estimé en dollars pour un volume de jetons.
 *
 * Estimation et non facture : le catalogue ignore les remises de cache, les
 * jetons de raisonnement parfois comptés à part, et les tarifs négociés.
 */
export function estimateCost(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const pricing = modelPricing(provider, modelId);
  if (!pricing) return undefined;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
