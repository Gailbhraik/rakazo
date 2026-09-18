import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

export interface BotModelOption {
  key: string;
  provider: string;
  modelId: string;
  /** Nom du modèle seul, sans le fournisseur. */
  name: string;
  providerName: string;
}

/** Au-delà, la liste devient illisible et lente à parcourir : on demande d'affiner. */
const MAX_LISTED = 150;

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Choix du modèle d'un seul bot.
 *
 * L'ancienne liste déroulante mélangeait « défaut de l'espace » et des
 * centaines de modèles OpenRouter, sans dire lequel était réellement utilisé.
 * Ici, l'état courant est affiché en premier et en clair — suit le défaut, ou
 * modèle propre à ce bot — et la liste ne s'ouvre qu'à la demande, avec une
 * recherche et les favoris en tête.
 *
 * Les favoris sont ceux de l'espace (`models.favorites`) : épingler un modèle
 * ici le rend aussi disponible dans la bascule rapide, et inversement.
 */
export function BotModelPicker({
  options,
  value,
  savedValue,
  defaultModel,
  onChange,
}: {
  options: BotModelOption[];
  /** Clé `fournisseur::modèle` choisie, ou "" pour suivre le défaut de l'espace. */
  value: string;
  /** Valeur enregistrée, pour signaler un choix pas encore enregistré. */
  savedValue: string;
  defaultModel: { name: string; providerName: string } | null;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [busyFavorite, setBusyFavorite] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    rpc.models
      .favorites()
      .then((rows) => {
        if (alive) setFavorites(new Set(rows.map((row) => `${row.provider}::${row.modelId}`)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery("");
  }, [open]);

  const selected = value ? options.find((option) => option.key === value) : undefined;
  const unsaved = value !== savedValue;

  // Chaque mot tapé doit se retrouver quelque part (nom, identifiant ou
  // fournisseur) : « claude sonnet » ou « deepseek flash » trouvent sans
  // connaître l'identifiant exact.
  const matches = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return options;
    return options.filter((option) => {
      const haystack = normalize(`${option.name} ${option.modelId} ${option.providerName}`);
      return words.every((word) => haystack.includes(word));
    });
  }, [options, query]);

  const favoriteMatches = matches.filter((option) => favorites.has(option.key));
  const others = matches.filter((option) => !favorites.has(option.key));
  const listed = others.slice(0, MAX_LISTED);
  const hidden = others.length - listed.length;
  const grouped = new Map<string, BotModelOption[]>();
  for (const option of listed) {
    const list = grouped.get(option.providerName);
    if (list) list.push(option);
    else grouped.set(option.providerName, [option]);
  }
  const groups = [...grouped];

  function choose(key: string) {
    onChange(key);
    setOpen(false);
  }

  async function toggleFavorite(option: BotModelOption) {
    setBusyFavorite(option.key);
    setFavoriteError(null);
    try {
      const { favorited } = await rpc.models.toggleFavorite({
        provider: option.provider,
        modelId: option.modelId,
      });
      setFavorites((current) => {
        const next = new Set(current);
        if (favorited) next.add(option.key);
        else next.delete(option.key);
        return next;
      });
    } catch (err) {
      setFavoriteError(err instanceof Error ? err.message : t`Could not update favorites`);
    } finally {
      setBusyFavorite(null);
    }
  }

  function row(option: BotModelOption) {
    const isSelected = option.key === value;
    const isFavorite = favorites.has(option.key);
    return (
      <li key={option.key} className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => choose(option.key)}
          aria-pressed={isSelected}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-start hover:bg-[var(--rk-n80)] ${
            isSelected ? "bg-[var(--rk-n80)]" : ""
          }`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-[var(--rk-n08)]">{option.name}</span>
            <span className="block truncate text-[11.5px] text-[var(--rk-n35)]">
              {option.modelId}
            </span>
          </span>
          {isSelected ? (
            <Check size={15} strokeWidth={2} className="shrink-0 text-[var(--rk-a04)]" />
          ) : null}
        </button>
        <button
          type="button"
          aria-label={isFavorite ? t`Remove from favorites` : t`Add to favorites`}
          aria-pressed={isFavorite}
          disabled={busyFavorite === option.key}
          onClick={() => void toggleFavorite(option)}
          className={`shrink-0 rounded-[8px] p-2 hover:bg-[var(--rk-n80)] disabled:opacity-40 ${
            isFavorite ? "text-[var(--rk-a17)]" : "text-[var(--rk-n45)]"
          }`}
        >
          <Star size={15} strokeWidth={1.8} fill={isFavorite ? "currentColor" : "none"} />
        </button>
      </li>
    );
  }

  return (
    <div className="mt-6" data-testid="bot-model-picker">
      <p className="text-[14px] text-[var(--rk-n29)]">
        <Trans>Model for this bot</Trans>
      </p>

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="mt-2 flex w-full items-center gap-3 rounded-[11px] border border-[var(--rk-n62)] px-3.5 py-3 text-start hover:border-[var(--rk-n45)]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] text-[var(--rk-n08)]">
              {value
                ? (selected?.name ?? value.split("::")[1] ?? value)
                : (defaultModel?.name ?? t`Space default`)}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                value
                  ? "bg-[var(--rk-a30)] text-[var(--rk-a04)]"
                  : "bg-[var(--rk-n80)] text-[var(--rk-n29)]"
              }`}
            >
              {value ? t`This bot only` : t`Space default`}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-[var(--rk-n35)]">
            {value
              ? (selected?.providerName ?? value.split("::")[0])
              : defaultModel
                ? t`${defaultModel.providerName} · follows the space setting`
                : t`Follows the space setting`}
          </span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={1.8}
          className={`shrink-0 text-[var(--rk-n29)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {unsaved ? (
        <p className="mt-1.5 text-[12.5px] text-[var(--rk-a04)]">
          <Trans>Not saved yet — press Save below.</Trans>
        </p>
      ) : null}

      {value && !open ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="mt-1.5 text-[12.5px] text-[var(--rk-n29)] underline-offset-2 hover:text-[var(--rk-n08)] hover:underline"
        >
          <Trans>Use the space default instead</Trans>
        </button>
      ) : null}

      {open ? (
        <div className="mt-2 overflow-hidden rounded-[11px] border border-[var(--rk-n62)] bg-[var(--rk-n93)]">
          <label className="flex items-center gap-2 border-b border-[var(--rk-n70)] px-3 py-2.5">
            <Search size={15} strokeWidth={1.8} className="shrink-0 text-[var(--rk-n35)]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const first = favoriteMatches[0] ?? listed[0];
                  if (first) choose(first.key);
                }
              }}
              aria-label={t`Search models`}
              placeholder={t`Search a model or provider…`}
              className="w-full bg-transparent text-[14px] text-[var(--rk-n08)] outline-none placeholder:text-[var(--rk-n35)]"
            />
            {query ? (
              <button
                type="button"
                aria-label={t`Clear search`}
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="shrink-0 text-[var(--rk-n35)] hover:text-[var(--rk-n08)]"
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            ) : null}
          </label>

          <div className="rk-scroll max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
            {favoriteError ? (
              <p role="alert" className="px-2.5 py-1.5 text-[12.5px] text-[var(--rk-a14)]">
                {favoriteError}
              </p>
            ) : null}

            {!query ? (
              <button
                type="button"
                onClick={() => choose("")}
                aria-pressed={!value}
                className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-start hover:bg-[var(--rk-n80)] ${
                  value ? "" : "bg-[var(--rk-n80)]"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-[var(--rk-n08)]">
                    <Trans>Space default</Trans>
                  </span>
                  <span className="block truncate text-[11.5px] text-[var(--rk-n35)]">
                    {defaultModel
                      ? t`Currently ${defaultModel.name} — changes when the space default changes`
                      : t`Changes when the space default changes`}
                  </span>
                </span>
                {value ? null : (
                  <Check size={15} strokeWidth={2} className="shrink-0 text-[var(--rk-a04)]" />
                )}
              </button>
            ) : null}

            {favoriteMatches.length > 0 ? (
              <>
                <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--rk-a17)]">
                  <Star size={11} strokeWidth={2} fill="currentColor" />
                  <Trans>Favorites</Trans>
                </p>
                <ul>{favoriteMatches.map(row)}</ul>
              </>
            ) : null}

            {groups.map(([providerName, entries]) => (
              <div key={providerName}>
                <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--rk-n35)]">
                  {providerName}
                </p>
                <ul>{entries.map(row)}</ul>
              </div>
            ))}

            {matches.length === 0 ? (
              <p className="px-2.5 py-3 text-[13px] text-[var(--rk-n35)]">
                {options.length === 0 ? (
                  <Trans>No model connected yet. Connect a provider in the model settings.</Trans>
                ) : (
                  <Trans>No connected model matches.</Trans>
                )}
              </p>
            ) : null}

            {hidden > 0 ? (
              <p className="px-2.5 py-2 text-[12.5px] text-[var(--rk-n35)]">
                <Trans>{hidden} more — type a few letters to narrow down.</Trans>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
