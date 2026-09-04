import { Trans, useLingui } from "@lingui/react/macro";
import { POKEMON_ANIMATED_MAX } from "@rakazo/contracts";
import { pokemonSpriteUrl } from "@rakazo/ui-web";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { POKEMON_NAMES, pokemonName } from "../lib/pokemon";

/**
 * Choix du Pokémon servant d'avatar à un bot.
 *
 * La grille n'affiche que des sprites : à cette taille, le nom se lit sous
 * l'image et la reconnaissance passe d'abord par la silhouette. Seules les
 * générations I à V sont proposées, faute d'animation au-delà.
 */
export function PokemonPickerOverlay({
  botName,
  current,
  onPick,
  onClose,
}: {
  botName: string;
  current: number | null;
  onPick: (pokemon: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const numbers = Array.from({ length: POKEMON_ANIMATED_MAX }, (_, index) => index + 1);
    if (!needle) return numbers;
    // Un chiffre saisi désigne un numéro ; sinon on cherche dans les noms.
    if (/^\d+$/.test(needle)) {
      return numbers.filter((number) => String(number).startsWith(needle));
    }
    return numbers.filter((number) => POKEMON_NAMES[number - 1]?.includes(needle));
  }, [query]);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pokemon-picker-title"
        onPointerDown={(event) => event.stopPropagation()}
        className="flex max-h-[82vh] w-full max-w-[560px] flex-col rounded-2xl border border-[#342725] bg-[#161110] shadow-[0_28px_70px_rgba(0,0,0,.6)]"
      >
        <div className="flex items-center justify-between border-b border-[#271E1C] px-5 py-4">
          <h2 id="pokemon-picker-title" className="text-[16px] text-[#EEECEC]">
            <Trans>Avatar for {botName}</Trans>
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

        <div className="border-b border-[#271E1C] px-5 py-3">
          <label className="flex items-center gap-2 rounded-[11px] border border-[#2F2321] bg-[#100C0B] px-3 py-2">
            <Search size={15} strokeWidth={1.8} className="shrink-0 text-[#7B6561]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search by name or number…`}
              className="w-full bg-transparent text-[14px] text-[#EEECEC] outline-none placeholder:text-[#7B6561]"
            />
          </label>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {results.length === 0 ? (
            <p className="py-8 text-center text-[13.5px] text-[#967E79]">
              <Trans>No match.</Trans>
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(78px,1fr))] gap-2">
              {results.map((number) => (
                <li key={number}>
                  <button
                    type="button"
                    onClick={() => onPick(number)}
                    title={pokemonName(number)}
                    className={`flex w-full flex-col items-center gap-1 rounded-[12px] border px-1 py-2 hover:border-[#6B2226] ${
                      current === number
                        ? "border-[#E0393E] bg-[#2A1517]"
                        : "border-transparent bg-[#1A1413]"
                    }`}
                  >
                    <img
                      src={pokemonSpriteUrl(number)}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      width={56}
                      height={56}
                      style={{ imageRendering: "pixelated", objectFit: "contain" }}
                    />
                    <span className="w-full truncate text-center text-[11.5px] text-[#B2A5A3]">
                      {pokemonName(number)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#271E1C] px-5 py-3">
          <span className="text-[12.5px] text-[#7B6561]">
            <Trans>Generations I–V only: later sprites are not animated.</Trans>
          </span>
          <button
            type="button"
            onClick={() => onPick(null)}
            disabled={current === null}
            className="shrink-0 rounded-[10px] border border-[#2F2321] px-3 py-1.5 text-[13px] text-[#D0C8C7] hover:border-[#463532] disabled:opacity-40"
          >
            <Trans>Generated avatar</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
