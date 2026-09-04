import { Trans, useLingui } from "@lingui/react/macro";
import type { FavoriteModel, ModelCatalogEntry } from "@rakazo/contracts";
import { Check, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";

/**
 * Bascule rapide entre les modèles épinglés.
 *
 * Le réglage complet des modèles reste dans son écran : ici, une liste courte
 * et un clic. Activer un favori applique le modèle et referme, parce que
 * l'objet de cette fenêtre est d'en sortir vite.
 */
export function FavoriteModelsOverlay({
  onClose,
  onModelChanged,
}: {
  onClose: () => void;
  onModelChanged?: () => void;
}) {
  const { t } = useLingui();
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [favs, entries, credentials] = await Promise.all([
          rpc.models.favorites(),
          rpc.models.list(),
          rpc.models.credentials(),
        ]);
        if (!alive) return;
        setFavorites(favs);
        setCatalog(entries);
        setConnected(new Set(credentials.map((credential) => credential.provider)));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t`Could not load models`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pinned = useMemo(
    () => new Set(favorites.map((favorite) => `${favorite.provider}:${favorite.modelId}`)),
    [favorites],
  );

  // La recherche ne sert qu'à épingler : les modèles déjà favoris en sont
  // retirés, et ceux dont le fournisseur n'est pas connecté ne peuvent pas
  // servir de raccourci.
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return catalog
      .filter((entry) => !entry.placeholder && connected.has(entry.provider))
      .filter((entry) => !pinned.has(`${entry.provider}:${entry.id}`))
      .filter(
        (entry) =>
          entry.id.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [query, catalog, connected, pinned]);

  async function refreshFavorites() {
    setFavorites(await rpc.models.favorites());
  }

  async function toggle(provider: string, modelId: string) {
    setBusy(`${provider}:${modelId}`);
    setError(null);
    try {
      await rpc.models.toggleFavorite({ provider, modelId });
      await refreshFavorites();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not update favorites`);
    } finally {
      setBusy(null);
    }
  }

  async function activate(favorite: FavoriteModel) {
    if (favorite.active || !favorite.available) return;
    setBusy(`${favorite.provider}:${favorite.modelId}`);
    setError(null);
    try {
      await rpc.models.setDefault({ provider: favorite.provider, modelId: favorite.modelId });
      onModelChanged?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not switch model`);
      setBusy(null);
    }
  }

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="favorite-models-title"
        onPointerDown={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-2xl border border-[#342725] bg-[#161110] shadow-[0_28px_70px_rgba(0,0,0,.6)]"
      >
        <div className="flex items-center justify-between border-b border-[#271E1C] px-5 py-4">
          <h2 id="favorite-models-title" className="text-[16px] text-[#EEECEC]">
            <Trans>Favorite models</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close`}
            onClick={onClose}
            className="text-[#967E79] hover:text-[#EEECEC]"
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="mb-3 text-[13.5px] text-[#F3A2AA]">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="text-[13.5px] text-[#967E79]">
              <Trans>Loading models…</Trans>
            </p>
          ) : favorites.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-[#342725] px-4 py-6 text-center text-[13.5px] text-[#967E79]">
              <Trans>No favorite yet. Search below to pin the models you switch between.</Trans>
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {favorites.map((favorite) => {
                const key = `${favorite.provider}:${favorite.modelId}`;
                return (
                  <li
                    key={key}
                    className={`flex items-center gap-3 rounded-[12px] border px-3 py-2.5 ${
                      favorite.active
                        ? "border-[#6B2226] bg-[#2A1517]"
                        : "border-[#271E1C] hover:border-[#463532]"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={!favorite.available || busy === key}
                      onClick={() => void activate(favorite)}
                      className="flex min-w-0 flex-1 flex-col items-start text-start disabled:cursor-default"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className="truncate text-[14.5px] text-[#EEECEC]">
                          {favorite.label}
                        </span>
                        {favorite.active ? (
                          <span className="flex shrink-0 items-center gap-1 text-[12px] text-[#F3A2AA]">
                            <Check size={13} strokeWidth={2} />
                            <Trans>Active</Trans>
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 truncate text-[12.5px] text-[#7B6561]">
                        {favorite.providerName ?? favorite.provider}
                        {favorite.reasoning ? " · " + t`Reasoning` : ""}
                        {favorite.available ? "" : " · " + t`Unavailable`}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t`Remove from favorites`}
                      disabled={busy === key}
                      onClick={() => void toggle(favorite.provider, favorite.modelId)}
                      className="shrink-0 rounded-[8px] p-1.5 text-[#E0393E] hover:bg-[#2A1517] disabled:opacity-40"
                    >
                      <Star size={15} strokeWidth={1.8} fill="currentColor" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-[#271E1C] px-5 py-4">
          <label className="flex items-center gap-2 rounded-[11px] border border-[#2F2321] bg-[#100C0B] px-3 py-2">
            <Search size={15} strokeWidth={1.8} className="shrink-0 text-[#7B6561]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search a model to pin…`}
              className="w-full bg-transparent text-[14px] text-[#EEECEC] outline-none placeholder:text-[#7B6561]"
            />
          </label>

          {results.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {results.map((entry) => {
                const key = `${entry.provider}:${entry.id}`;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      disabled={busy === key}
                      onClick={() => void toggle(entry.provider, entry.id)}
                      className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-start hover:bg-[#1D1614] disabled:opacity-40"
                    >
                      <Star size={14} strokeWidth={1.8} className="shrink-0 text-[#7B6561]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-[#EEECEC]">
                          {entry.label}
                        </span>
                        <span className="block truncate text-[12.5px] text-[#7B6561]">
                          {entry.providerName ?? entry.provider}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : query.trim().length >= 2 ? (
            <p className="mt-2 text-[13px] text-[#7B6561]">
              <Trans>No connected model matches.</Trans>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
