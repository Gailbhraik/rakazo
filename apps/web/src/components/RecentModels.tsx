import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { BuiCard } from "./beautiful-ui/primitives";

type Catalog = Awaited<ReturnType<typeof rpc.models.recent>>;
const price = (value: number | null) =>
  value === null
    ? "Non communiqué"
    : new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value);
const tokens = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(
        value,
      );
export function RecentModels({ revision }: { revision: number }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    rpc.models
      .recent()
      .then((value) => {
        if (alive) setCatalog(value);
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
  }, [revision]);
  return (
    <section className="mb-8" aria-labelledby="recent-models-title">
      <h2 id="recent-models-title" className="mb-2 text-lg font-semibold">
        Nouveautés OpenRouter
      </h2>
      <p className="mb-4 text-xs text-[var(--rk-muted)]">
        Derniers ajouts au catalogue. Tarifs en dollars pour 1 million de tokens, hors frais
        supplémentaires ; ce ne sont pas tes dépenses réelles.
      </p>
      {loading && (
        <p role="status" className="mb-3 text-sm">
          Actualisation du catalogue…
        </p>
      )}
      {(error || catalog?.stale) && (
        <p role="status" className="mb-3 text-sm text-[var(--rk-muted)]">
          Catalogue momentanément indisponible.
          {catalog
            ? " Dernières données connues affichées."
            : " Utilise le bouton d’actualisation pour réessayer."}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {catalog?.models.slice(0, expanded ? 12 : 4).map((model) => (
          <BuiCard key={model.id} className="min-w-0 p-5">
            <div className="mb-3">
              <h3 className="break-words text-base font-semibold">{model.name}</h3>
              <p className="mt-1 text-xs text-[var(--rk-muted)]">
                Ajouté le {new Date(model.created * 1000).toLocaleDateString("fr-FR")}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-[var(--rk-muted)]">Entrée / 1 M tokens</dt>
                <dd className="mt-1 font-semibold">{price(model.inputPrice)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--rk-muted)]">Sortie / 1 M tokens</dt>
                <dd className="mt-1 font-semibold">{price(model.outputPrice)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--rk-muted)]">Contexte (tokens)</dt>
                <dd>{tokens(model.context)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--rk-muted)]">Sortie max. (tokens)</dt>
                <dd>{tokens(model.maxOutput)}</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--rk-muted)]">
              {model.modalities.map((modality) => (
                <span className="rounded-md bg-[var(--rk-surface)] px-2 py-1" key={modality}>
                  {(
                    { text: "Texte", image: "Image", audio: "Audio", video: "Vidéo" } as Record<
                      string,
                      string
                    >
                  )[modality] ?? modality}
                </span>
              ))}
              {model.tools && (
                <span className="rounded-md bg-[var(--rk-surface)] px-2 py-1">Outils</span>
              )}
              {model.reasoning && (
                <span className="rounded-md bg-[var(--rk-surface)] px-2 py-1">Raisonnement</span>
              )}
            </div>
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-[var(--rk-accent)]">
                Coût estimé et détails
              </summary>
              <div className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--rk-muted)]">
                <p>
                  Exemple : 10 000 tokens en entrée + 2 000 en sortie ≈{" "}
                  <strong>
                    {model.inputPrice === null || model.outputPrice === null
                      ? "non calculable"
                      : price(model.inputPrice * 0.01 + model.outputPrice * 0.002)}
                  </strong>
                  , hors cache et autres frais.
                </p>
                {model.cachePrice !== null && (
                  <p>Lecture du cache : {price(model.cachePrice)} / 1 M tokens.</p>
                )}
                {model.variablePricing && (
                  <p>Des tarifs variables selon les horaires ou conditions sont annoncés.</p>
                )}
                {model.description && <p>{model.description}</p>}
                <p className="break-all font-mono">{model.id}</p>
              </div>
            </details>
            <a
              className="mt-4 inline-block text-sm text-[var(--rk-accent)]"
              href={`https://openrouter.ai/${model.id.split("/").map(encodeURIComponent).join("/")}`}
              target="_blank"
              rel="noreferrer"
            >
              Fiche OpenRouter ↗
            </a>
          </BuiCard>
        ))}
      </div>
      {catalog && catalog.models.length > 4 && (
        <button
          type="button"
          className="mt-4 rounded-xl border border-[var(--rk-hairline-strong)] px-4 py-2 text-sm"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Afficher moins" : `Voir les ${catalog.models.length} derniers modèles`}
        </button>
      )}
      {catalog && (
        <p className="mt-3 text-xs text-[var(--rk-muted)]">
          Source : catalogue OpenRouter · relevé le{" "}
          {new Date(catalog.fetchedAt).toLocaleString("fr-FR")} · actualisation au plus toutes les 5
          minutes.
        </p>
      )}
    </section>
  );
}
