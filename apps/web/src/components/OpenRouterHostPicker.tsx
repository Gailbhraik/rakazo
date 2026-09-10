import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
export function OpenRouterHostPicker({
  modelId,
  value,
  onChange,
}: {
  modelId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    setHosts([]);
    rpc.models
      .hosts({ modelId })
      .then((rows) => {
        if (alive) setHosts(rows);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [modelId, retry]);
  return (
    <div className="mt-4">
      <label className="block text-sm text-[var(--rk-muted)]">
        Hébergeur OpenRouter
        <select
          aria-label="Hébergeur OpenRouter"
          className="mt-2 w-full rounded-xl border border-[var(--rk-hairline-strong)] bg-[var(--rk-panel)] px-3 py-3 text-[var(--rk-ink)]"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Automatique — choix OpenRouter</option>
          {value && !hosts.some((host) => host.id === value) && (
            <option value={value}>{value} (enregistré)</option>
          )}
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name} · {host.id}
            </option>
          ))}
        </select>
      </label>
      {loading && (
        <p role="status" className="mt-2 text-xs">
          Chargement des hébergeurs…
        </p>
      )}
      {error && (
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="mt-2 text-xs text-[var(--rk-accent)]"
        >
          Liste indisponible · Réessayer
        </button>
      )}
      <p className="mt-2 text-xs text-[var(--rk-muted)]">
        {value
          ? "Hébergeur imposé : aucun repli vers un autre s’il est indisponible."
          : "OpenRouter sélectionne un hébergeur disponible pour ce modèle."}
      </p>
    </div>
  );
}
