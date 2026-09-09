import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:6767";

export function SupermemorySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);

  async function connect() {
    if (!apiKey.trim()) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        mode,
        ...(mode === "local" ? { baseUrl: baseUrl.trim() } : {}),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <div className="flex gap-2">
        {(["cloud", "local"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            disabled={busy}
            onClick={() => setMode(option)}
            className={`flex-1 rounded-[11px] border px-3.5 py-2.5 text-[14px] disabled:opacity-40 ${
              mode === option
                ? "border-[var(--rk-n42)] bg-[var(--rk-n80)] text-[var(--rk-n08)]"
                : "border-[var(--rk-n62)] text-[var(--rk-n29)]"
            }`}
          >
            {option === "cloud" ? <Trans>Cloud</Trans> : <Trans>Local</Trans>}
          </button>
        ))}
      </div>

      {mode === "local" ? (
        <label className="mt-4 block text-[13.5px] text-[var(--rk-n29)]">
          <Trans>Base URL</Trans>
          <input
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_LOCAL_BASE_URL}
            className="mt-2 w-full rounded-[11px] border border-[var(--rk-n62)] bg-[var(--rk-n93)] px-3.5 py-3 text-[var(--rk-n08)] outline-none disabled:opacity-40"
          />
        </label>
      ) : null}

      <label className="mt-4 block text-[13.5px] text-[var(--rk-n29)]">
        {mode === "cloud" ? <Trans>Organization API key</Trans> : <Trans>Instance API key</Trans>}
        <input
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sm_…"
          type="password"
          autoComplete="new-password"
          className="mt-2 w-full rounded-[11px] border border-[var(--rk-n62)] bg-[var(--rk-n93)] px-3.5 py-3 text-[var(--rk-n08)] outline-none disabled:opacity-40"
        />
      </label>

      <Button
        type="button"
        variant="pill"
        size="sm"
        disabled={busy || apiKey.trim().length < 8 || (mode === "local" && !baseUrl.trim())}
        onClick={() => void connect()}
        className="mt-5"
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
