import { describe, expect, it, vi } from "vitest";
import { readProviderBalance } from "./provider-balances.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("provider balances", () => {
  it("subtracts account usage without leaking the API key", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ data: { total_credits: 20, total_usage: 3.5 } }));
    const result = await readProviderBalance("openrouter", "fake-test-key", request);
    expect(result.amounts).toEqual([{ currency: "USD", remaining: 16.5, scope: "account" }]);
    expect(JSON.stringify(result)).not.toContain("fake-test-key");
    expect(request.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/credits");
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("labels the key budget separately when account balance is forbidden", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({ data: { limit_remaining: 4 } }));
    expect((await readProviderBalance("openrouter", "fake", request)).amounts).toEqual([
      { currency: "USD", remaining: 4, scope: "key" },
    ]);
  });
  it("does not present an unlimited key as a zero or infinite account balance", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({ data: { limit_remaining: null } }));
    expect(await readProviderBalance("openrouter", "fake", request)).toMatchObject({
      status: "unavailable",
      amounts: [],
    });
  });
  it("preserves separate DeepSeek currencies", async () => {
    const request = vi.fn().mockResolvedValue(
      response({
        balance_infos: [
          { currency: "USD", total_balance: "2.50" },
          { currency: "CNY", total_balance: "10.00" },
        ],
      }),
    );
    expect((await readProviderBalance("deepseek", "fake", request)).amounts).toHaveLength(2);
  });
  it("rejects malformed values and hides upstream errors", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ balance_infos: [{ currency: "USD", total_balance: "oops" }] }));
    expect(await readProviderBalance("deepseek", "fake", request)).toMatchObject({
      status: "unavailable",
      amounts: [],
    });
  });
  it("never sends a key to unsupported providers", async () => {
    const request = vi.fn();
    expect((await readProviderBalance("custom", "fake", request)).status).toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });
});
