import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { registerExtraModels } from "./pi-extra-models.js";

describe("DeepSeek V4.1 Flash", () => {
  it("registers a runnable vision model with supported reasoning levels", () => {
    const models = registerExtraModels(builtinModels());
    const model = models.getModel("openrouter", "deepseek/deepseek-v4.1-flash");
    expect(model).toMatchObject({
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 384000,
      reasoning: true,
      compat: { thinkingFormat: "openrouter" },
    });
    expect(model?.thinkingLevelMap?.medium).toBe("high");
    registerExtraModels(models);
    expect(
      models
        .getProvider("openrouter")
        ?.getModels()
        .filter((row) => row.id === model?.id),
    ).toHaveLength(1);
  });
});
