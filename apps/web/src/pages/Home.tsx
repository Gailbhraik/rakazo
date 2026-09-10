import type { Bot, Group } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { ArrowUpRight, Cpu, MessageCircle, Puzzle, RefreshCw, Settings, Star } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BuiButton, BuiCard } from "../components/beautiful-ui/primitives";
import { WeatherWidget } from "../components/WeatherWidget";

import { authClient } from "../lib/auth";
import { rpc } from "../lib/rpc";

const Models = lazy(() =>
  import("./ModelSettingsOverlay").then((m) => ({ default: m.ModelSettingsOverlay })),
);
const Favorites = lazy(() =>
  import("./FavoriteModelsOverlay").then((m) => ({ default: m.FavoriteModelsOverlay })),
);
const Plugins = lazy(() => import("./PluginsOverlay").then((m) => ({ default: m.PluginsOverlay })));
const Mcp = lazy(() =>
  import("./McpServersOverlay").then((m) => ({ default: m.McpServersOverlay })),
);
type Balance = Awaited<ReturnType<typeof rpc.usage.balances>>[number];
const names: Record<string, string> = {
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};
const money = (value: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(value);
export function HomePage() {
  const session = authClient.useSession();
  const [bots, setBots] = useState<Bot[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [error, setError] = useState("");
  const [balanceError, setBalanceError] = useState("");
  const [panel, setPanel] = useState<"models" | "favorites" | "plugins" | "mcp" | null>(null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([rpc.bots.list(), rpc.groups.list()])
      .then(([nextBots, nextGroups]) => {
        if (alive) {
          setBots(nextBots);
          setGroups(nextGroups);
        }
      })
      .catch(() => {
        if (alive) setError("Impossible de charger les conversations.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  useEffect(() => {
    let alive = true;
    setBalanceLoading(true);
    setBalanceError("");
    rpc.usage
      .balances()
      .then((rows) => {
        if (alive) setBalances(rows);
      })
      .catch(() => {
        if (alive) {
          setBalances([]);
          setBalanceError("Impossible de consulter les crédits. Réessaie dans un instant.");
        }
      })
      .finally(() => {
        if (alive) setBalanceLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  const close = () => {
    setPanel(null);
    setRevision((value) => value + 1);
  };
  return (
    <div className="rk-home h-full overflow-y-auto" data-testid="home-page">
      <main className="mx-auto w-full max-w-5xl px-5 pb-12 pt-8 sm:px-8 sm:pt-12">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[.18em] text-[var(--rk-muted)]">
              ASHITAKA
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Bonjour{session.data?.user.name ? `, ${session.data.user.name.split(" ")[0]}` : ""}
            </h1>
            <p className="mt-2 text-sm text-[var(--rk-muted)]">
              Ton équipe, tes outils et tes crédits.
            </p>
          </div>
          <button
            type="button"
            aria-label="Actualiser l’accueil"
            disabled={loading || balanceLoading}
            onClick={() => setRevision((value) => value + 1)}
            className="rk-home-refresh"
          >
            <RefreshCw size={18} />
          </button>
        </header>
        <WeatherWidget />
        <section aria-labelledby="credits-title" className="mb-8">
          <h2 id="credits-title" className="mb-3 text-lg font-semibold">
            Crédits API
          </h2>
          {balanceLoading ? (
            <p role="status" className="text-sm text-[var(--rk-muted)]">
              Consultation des fournisseurs…
            </p>
          ) : balanceError ? (
            <p role="alert">{balanceError}</p>
          ) : balances.length === 0 ? (
            <BuiCard className="p-5">
              <p className="mb-3 text-sm">
                Connecte un fournisseur pour retrouver ses crédits ici.
              </p>
              <BuiButton onClick={() => setPanel("models")}>Connecter un fournisseur</BuiButton>
            </BuiCard>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {balances.map((row) => (
                <BuiCard key={row.provider} className="p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{names[row.provider] ?? row.provider}</span>
                    <span className="text-xs text-[var(--rk-muted)]">
                      {row.status === "available" ? "À jour" : "Non disponible"}
                    </span>
                  </div>
                  {row.status === "available" ? (
                    row.amounts.map((amount) => (
                      <div key={amount.currency}>
                        <p className="mt-3 text-3xl font-semibold tracking-tight">
                          {money(amount.remaining, amount.currency)}
                        </p>
                        <p className="mt-1 text-xs text-[var(--rk-muted)]">
                          {amount.scope === "account"
                            ? "Solde du compte fournisseur"
                            : "Budget restant de cette clé · solde du compte inaccessible"}
                        </p>
                        {amount.remaining <= 0 && (
                          <p className="mt-2 text-sm text-red-500">Crédit épuisé</p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="my-3 text-sm text-[var(--rk-muted)]">
                      {row.status === "unsupported"
                        ? "Ce fournisseur ne propose pas de solde consultable dans l’application."
                        : "Le solde n’est pas accessible avec cette connexion. Vérifie les crédits chez le fournisseur."}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-[var(--rk-muted)]">
                    Vérifié à{" "}
                    {new Date(row.checkedAt).toLocaleTimeString("fr-FR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                  {row.provider === "openrouter" && (
                    <a
                      className="mt-3 inline-flex items-center gap-1 text-sm text-[var(--rk-accent)]"
                      href="https://openrouter.ai/settings/credits"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gérer les crédits <ArrowUpRight size={14} />
                    </a>
                  )}
                </BuiCard>
              ))}
            </div>
          )}
        </section>
        <section aria-labelledby="tools-title" className="mb-8">
          <h2 id="tools-title" className="mb-3 text-lg font-semibold">
            Accès rapides
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              {
                id: "favorites" as const,
                label: "Modèles favoris",
                description: "Choisir ton IA",
                Icon: Star,
              },
              {
                id: "models" as const,
                label: "Fournisseurs",
                description: "Modèles et connexions",
                Icon: Cpu,
              },
              {
                id: "plugins" as const,
                label: "Intégrations",
                description: "Apps et outils",
                Icon: Puzzle,
              },
              {
                id: "mcp" as const,
                label: "Serveurs MCP",
                description: "Outils connectés",
                Icon: Settings,
              },
            ].map(({ id, label, description, Icon }) => (
              <button type="button" key={id} className="rk-home-tile" onClick={() => setPanel(id)}>
                <Icon size={22} className="mb-4 text-[var(--rk-accent)]" />
                <span className="block text-sm font-semibold">{label}</span>
                <span className="mt-1 block text-xs text-[var(--rk-muted)]">{description}</span>
              </button>
            ))}
          </div>
        </section>
        <Link to="/models/new" className="rk-home-bot mb-8">
          <Cpu size={22} className="text-[var(--rk-accent)]" />
          <span className="flex-1 text-sm font-semibold">Nouveautés OpenRouter</span>
          <ArrowUpRight size={17} />
        </Link>
        <section aria-labelledby="bots-title">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="bots-title" className="text-lg font-semibold">
              Tes conversations
            </h2>
            <span className="text-sm text-[var(--rk-muted)]">{bots.length} bots</span>
          </div>
          <input
            aria-label="Rechercher un bot ou un groupe"
            className="mb-4 w-full rounded-xl border border-[var(--rk-hairline-strong)] bg-[var(--rk-panel)] px-4 py-3 text-sm"
            placeholder="Rechercher un bot ou un groupe…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading && <p role="status">Chargement…</p>}
          {error && <p role="alert">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {bots
              .filter((bot) => bot.name.toLowerCase().includes(query.toLowerCase()))
              .sort(
                (a, b) =>
                  (Date.parse(b.lastActivityAt ?? "") || 0) -
                    (Date.parse(a.lastActivityAt ?? "") || 0) ||
                  Date.parse(b.createdAt) - Date.parse(a.createdAt),
              )
              .map((bot) => (
                <Link key={bot.id} to={`/app/${bot.id}`} className="rk-home-bot">
                  <BotAvatar
                    pokemon={bot.pokemon}
                    color={bot.color}
                    identity={bot.id}
                    status={bot.status}
                    size={44}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{bot.name}</span>
                    <span className="block text-xs text-[var(--rk-muted)]">
                      Conversation · ordinateur · carnet dev
                    </span>
                  </span>
                  <ArrowUpRight size={17} />
                </Link>
              ))}
            {groups
              .filter((group) => group.name.toLowerCase().includes(query.toLowerCase()))
              .map((group) => (
                <Link key={group.id} to={`/app/g/${group.id}`} className="rk-home-bot">
                  <MessageCircle size={24} />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <ArrowUpRight size={17} />
                </Link>
              ))}
          </div>
          {!loading && !error && !bots.length && !groups.length && (
            <Link className="inline-block py-4 text-[var(--rk-accent)]" to="/onboarding">
              Créer ton premier bot →
            </Link>
          )}
        </section>
      </main>
      <Suspense
        fallback={
          <div role="status" className="fixed bottom-4 left-4 rounded-xl bg-[var(--rk-panel)] p-4">
            Ouverture…
          </div>
        }
      >
        <div className={panel ? "fixed inset-0 z-50" : "hidden"}>
          {panel === "models" && <Models onClose={close} />}
          {panel === "favorites" && <Favorites onClose={close} />}
          {panel === "plugins" && <Plugins onClose={close} onOpenMcp={() => setPanel("mcp")} />}
          {panel === "mcp" && <Mcp onClose={close} />}
        </div>
      </Suspense>
    </div>
  );
}
