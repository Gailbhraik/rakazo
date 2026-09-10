import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { withOpenRouterHost } from "./openrouter-hosts.js";

const model = builtinModels().getProvider("openrouter")!.getModels()[0]!;
describe("OpenRouter host routing", () => {
  it("restricts calls to the selected host and disables fallback", async () => {
    const options = withOpenRouterHost({}, "openrouter", "deepseek");
    expect(await options?.onPayload?.({ model: "test", provider: { zdr: true } }, model)).toEqual({
      model: "test",
      provider: { zdr: true, only: ["deepseek"], allow_fallbacks: false },
    });
  });
  it("preserves existing payload hooks and enforces routing afterwards", async () => {
    const options = withOpenRouterHost(
      { onPayload: () => ({ messages: [], provider: { only: ["other"] } }) },
      "openrouter",
      "novita",
    );
    expect(await options?.onPayload?.({}, model)).toMatchObject({
      messages: [],
      provider: { only: ["novita"], allow_fallbacks: false },
    });
  });
  it("leaves automatic routing and other providers unchanged", () => {
    const options = { temperature: 0.2 };
    expect(withOpenRouterHost(options, "openrouter", null)).toBe(options);
    expect(withOpenRouterHost(options, "deepseek", "novita")).toBe(options);
  });
});
