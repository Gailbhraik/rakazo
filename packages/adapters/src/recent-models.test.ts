import { describe, expect, it } from "vitest";
import { normalizeRecentModels } from "./recent-models.js";

describe("recent OpenRouter models", () => {
  it("sorts by addition date and converts prices per million tokens", () => {
    const rows = normalizeRecentModels({
      data: [
        { id: "old", name: "Old", created: 1 },
        {
          id: "new",
          name: "New",
          created: 2,
          pricing: { prompt: "0.0000003", completion: "0.0000012" },
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      id: "new",
      inputPrice: 0.3,
      outputPrice: 1.2,
      tools: true,
      reasoning: true,
    });
    expect(rows[1]?.inputPrice).toBeNull();
  });
  it("distinguishes zero prices from malformed or negative prices", () => {
    const [row] = normalizeRecentModels({
      data: [
        {
          id: "a",
          name: "A",
          created: 1,
          pricing: { prompt: "0", completion: "-1", input_cache_read: "invalid" },
        },
      ],
    });
    expect(row).toMatchObject({ inputPrice: 0, outputPrice: null, cachePrice: null });
  });
  it("caps the list and ignores malformed rows", () => {
    expect(
      normalizeRecentModels({
        data: [
          null,
          {},
          ...Array.from({ length: 20 }, (_, i) => ({
            id: `model-${i}`,
            name: "Model",
            created: i + 1,
          })),
        ],
      }),
    ).toHaveLength(12);
    expect(() => normalizeRecentModels({})).toThrow();
  });
});
