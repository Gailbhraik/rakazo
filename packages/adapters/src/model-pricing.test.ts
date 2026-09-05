import { describe, expect, it } from "vitest";
import { estimateCost, modelPricing } from "./model-pricing.js";

describe("model-pricing", () => {
  it("lit le tarif du catalogue en dollars par million de jetons", () => {
    const pricing = modelPricing("openrouter", "z-ai/glm-5.3-flash");
    expect(pricing).toBeDefined();
    expect(pricing?.input).toBeGreaterThan(0);
    expect(pricing?.output).toBeGreaterThan(pricing?.input ?? 0);
  });

  it("facture séparément entrée et sortie", () => {
    const pricing = modelPricing("openrouter", "z-ai/glm-5.3-flash");
    if (!pricing) throw new Error("tarif absent du catalogue");
    const cost = estimateCost("openrouter", "z-ai/glm-5.3-flash", 2_000_000, 1_000_000);
    expect(cost).toBeCloseTo(pricing.input * 2 + pricing.output, 6);
  });

  it("ne rend rien pour un modèle absent du catalogue", () => {
    // Un serveur OpenAI-compatible n'a pas de tarif public : afficher zéro se
    // lirait « gratuit », d'où `undefined` que l'appelant traduit en tiret.
    expect(modelPricing("openai-compatible", "z-ai/glm-5.3-flash")).toBeUndefined();
    expect(estimateCost("openai-compatible", "z-ai/glm-5.3-flash", 1000, 1000)).toBeUndefined();
  });
});
