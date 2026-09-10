import { parseModelSecret } from "./pi-oauth.js";

export type ProviderBalance = {
  provider: string;
  status: "available" | "unavailable" | "unsupported";
  amounts: { currency: string; remaining: number; scope: "account" | "key" }[];
  checkedAt: string;
};
const finite = (value: unknown): number => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === "" ||
    !Number.isFinite(Number(value))
  )
    throw new Error("Invalid amount");
  return Number(value);
};
/** Only fixed provider endpoints receive keys. Raw upstream errors never leave this adapter. */
export async function readProviderBalance(
  provider: string,
  plaintext: string,
  request: typeof fetch = fetch,
): Promise<ProviderBalance> {
  const result: ProviderBalance = {
    provider,
    status: "unavailable",
    amounts: [],
    checkedAt: new Date().toISOString(),
  };
  if (!["openrouter", "deepseek"].includes(provider)) return { ...result, status: "unsupported" };
  try {
    const secret = parseModelSecret(plaintext);
    if (secret.kind !== "api_key") return result;
    const get = async (url: string) => {
      const response = await request(url, {
        headers: { Authorization: `Bearer ${secret.key}` },
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Balance unavailable");
      return response.json();
    };
    if (provider === "openrouter") {
      // Account credits may require a management key. The per-key budget is a distinct fallback.
      try {
        const body = await get("https://openrouter.ai/api/v1/credits");
        result.amounts = [
          {
            currency: "USD",
            remaining: finite(body.data.total_credits) - finite(body.data.total_usage),
            scope: "account",
          },
        ];
      } catch {
        const body = await get("https://openrouter.ai/api/v1/key");
        if (body.data.limit_remaining == null) return result;
        result.amounts = [
          { currency: "USD", remaining: finite(body.data.limit_remaining), scope: "key" },
        ];
      }
    } else {
      const body = await get("https://api.deepseek.com/user/balance");
      if (!Array.isArray(body.balance_infos) || !body.balance_infos.length) return result;
      result.amounts = body.balance_infos.map(
        (row: { currency: unknown; total_balance: unknown }) => {
          if (row.currency !== "USD" && row.currency !== "CNY") throw new Error("Invalid currency");
          return {
            currency: row.currency,
            remaining: finite(row.total_balance),
            scope: "account" as const,
          };
        },
      );
    }
    return { ...result, status: "available" };
  } catch {
    return result;
  }
}
