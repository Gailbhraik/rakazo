import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
export async function listOpenRouterHosts(
  modelId: string,
): Promise<{ id: string; name: string }[]> {
  const path = modelId.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Hosts unavailable");
  const body = await response.json();
  if (!Array.isArray(body.data?.endpoints)) throw new Error("Invalid endpoints");
  const hosts = new Map<string, { id: string; name: string }>();
  for (const row of body.data.endpoints) {
    if (
      typeof row.tag === "string" &&
      /^[a-zA-Z0-9_./-]{1,120}$/.test(row.tag) &&
      typeof row.provider_name === "string"
    )
      hosts.set(row.tag, { id: row.tag, name: row.provider_name });
  }
  return [...hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function withOpenRouterHost(
  options: SimpleStreamOptions | undefined,
  provider: string,
  host?: string | null,
): SimpleStreamOptions | undefined {
  if (provider !== "openrouter" || !host) return options;
  const previous = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const updated = (await previous?.(payload, model)) ?? payload;
      if (!updated || typeof updated !== "object" || Array.isArray(updated))
        throw new Error("Invalid OpenRouter payload");
      const body = updated as Record<string, unknown>;
      const routing = body.provider && typeof body.provider === "object" ? body.provider : {};
      return { ...body, provider: { ...routing, only: [host], allow_fallbacks: false } };
    },
  };
}
