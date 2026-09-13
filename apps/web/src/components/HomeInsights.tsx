import type { Bot, RunActivityRow } from "@rakazo/contracts";
import {
  Battery,
  BatteryCharging,
  CalendarClock,
  CircleAlert,
  HardDrive,
  Thermometer,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type HostSnapshot, monitorBase } from "../lib/monitor";
import { rpc } from "../lib/rpc";
import { BuiCard } from "./beautiful-ui/primitives";

/**
 * Ce que l'accueil doit dire en un coup d'œil : est-ce que tout va bien ?
 *
 * Quatre réponses partielles, chacune tirée d'une source existante : l'état de
 * l'hôte (service de supervision), les derniers runs, les routines à venir et
 * la dépense récente. Aucune n'invente de donnée ; quand une source manque, son
 * bloc se tait ou le dit, sans empêcher les autres de s'afficher.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function upcomingTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return `Aujourd’hui ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Demain ${time}`;
  return `${date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })} ${time}`;
}

/* ------------------------------------------------------------------------- */
/* État de l'hôte                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Bandeau d'état de la machine hôte.
 *
 * Le service de supervision est optionnel : injoignable, le bandeau ne
 * s'affiche pas du tout. Une instance qui ne l'a pas installé n'a pas à lire un
 * message d'erreur à chaque ouverture de l'accueil.
 */
export function HostStatusStrip({ onOpen }: { onOpen: () => void }) {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const base = monitorBase();
    async function load() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(`${base}/api/metrics`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as HostSnapshot;
        if (alive) setSnapshot(payload);
      } catch {
        // Un relevé manqué garde le précédent : le bandeau ne clignote pas au
        // moindre hoquet réseau. Seule une absence initiale le laisse masqué.
      } finally {
        clearTimeout(timer);
      }
    }
    void load();
    // L'accueil n'est pas un tableau de bord : un relevé toutes les 30 s suffit
    // à signaler une alerte sans solliciter le service inutilement.
    const interval = setInterval(() => void load(), 30000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const now = snapshot?.now;
  if (!snapshot?.ready || !now) return null;

  const problems: string[] = [];
  if (now.battery.on_ac === false) {
    problems.push(`Sur batterie (${now.battery.capacity ?? "?"} %)`);
  }
  for (const [name, entry] of Object.entries(now.disk)) {
    if (entry.percent >= 95) problems.push(`Disque ${name} à ${Math.round(entry.percent)} %`);
  }
  if (now.memory.percent >= 92) problems.push(`Mémoire à ${Math.round(now.memory.percent)} %`);
  if ((now.temps.apu ?? 0) >= 90) problems.push(`Processeur à ${now.temps.apu} °C`);
  for (const [name, probe] of Object.entries(snapshot.services ?? {})) {
    if (!probe.ok) problems.push(`${name} ne répond pas`);
  }

  const ok = problems.length === 0;
  const home = now.disk.home ?? Object.values(now.disk)[0];
  const BatteryIcon = now.battery.on_ac ? BatteryCharging : Battery;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ok ? "État du Deck : tout va bien" : `État du Deck : ${problems.join(", ")}`}
      className={`mb-6 flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-3 text-left text-sm transition ${
        ok
          ? "border-[var(--rk-hairline)] bg-[var(--rk-panel)] hover:border-[var(--rk-hairline-strong)]"
          : "border-red-500/40 bg-red-500/10 hover:border-red-500/60"
      }`}
    >
      <span className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
        />
        {ok ? "Deck en bonne santé" : problems.join(" · ")}
      </span>
      <span className="flex items-center gap-4 text-[var(--rk-muted)] tabular-nums">
        {now.battery.capacity !== null ? (
          <span className="flex items-center gap-1">
            <BatteryIcon size={15} aria-hidden="true" />
            {now.battery.capacity} %
          </span>
        ) : null}
        {now.temps.apu !== undefined ? (
          <span className="flex items-center gap-1">
            <Thermometer size={15} aria-hidden="true" />
            {Math.round(now.temps.apu)} °C
          </span>
        ) : null}
        {home ? (
          <span className="flex items-center gap-1">
            <HardDrive size={15} aria-hidden="true" />
            {Math.round(home.percent)} %
          </span>
        ) : null}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------- */
/* Activité récente                                                           */
/* ------------------------------------------------------------------------- */

function statusDot(status: RunActivityRow["status"]): string {
  if (status === "failed") return "bg-red-500";
  if (status === "completed") return "bg-emerald-500";
  if (status === "cancelled") return "bg-zinc-500";
  if (status === "waiting_input" || status === "waiting_takeover") return "bg-amber-500";
  return "bg-violet-500";
}

function statusLabel(status: RunActivityRow["status"]): string {
  if (status === "failed") return "Échec";
  if (status === "completed") return "Terminé";
  if (status === "cancelled") return "Annulé";
  if (status === "waiting_input" || status === "waiting_takeover") return "En attente";
  return "En cours";
}

/**
 * Les derniers runs, échecs en évidence.
 *
 * Le 11 septembre 2026, sept runs ont échoué en treize heures sans que rien ne
 * le signale. C'est ce que ce bloc rend visible à l'ouverture de l'application.
 */
export function RecentRunsCard() {
  const [runs, setRuns] = useState<RunActivityRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    rpc.runs
      .list({ filter: "recent", limit: 5 })
      .then((result) => {
        if (alive) setRuns(result.runs);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const failures = runs?.filter((run) => run.status === "failed").length ?? 0;

  return (
    <BuiCard className="p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">Activité récente</h3>
        {failures > 0 ? (
          <span className="flex items-center gap-1 text-xs font-medium text-red-500">
            <CircleAlert size={14} aria-hidden="true" />
            {failures} échec{failures > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="text-sm text-[var(--rk-muted)]">Activité indisponible pour l’instant.</p>
      ) : runs === null ? (
        <p role="status" className="text-sm text-[var(--rk-muted)]">
          Chargement…
        </p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-[var(--rk-muted)]">Aucun run pour l’instant.</p>
      ) : (
        <ul className="grid gap-1">
          {runs.map((run) => (
            <li key={run.runId}>
              <Link
                to={run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--rk-surface)]"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${statusDot(run.status)}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {run.groupName ?? run.botName}
                  </span>
                  <span className="block truncate text-xs text-[var(--rk-muted)]">
                    {run.promptSnippet || "—"}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <span
                    className={`block ${run.status === "failed" ? "font-medium text-red-500" : "text-[var(--rk-muted)]"}`}
                  >
                    {statusLabel(run.status)}
                  </span>
                  <span className="block text-[var(--rk-muted)]">{relativeTime(run.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </BuiCard>
  );
}

/* ------------------------------------------------------------------------- */
/* Routines à venir                                                           */
/* ------------------------------------------------------------------------- */

type Upcoming = { id: string; name: string; botId: string; botName: string; nextRunAt: string };

/**
 * Ce que les bots feront d'eux-mêmes dans les prochaines heures.
 *
 * L'API ne liste les routines que bot par bot : on les interroge en parallèle,
 * et un bot dont la requête échoue est simplement omis plutôt que de masquer
 * les routines des autres.
 */
export function UpcomingRoutinesCard({ bots }: { bots: Bot[] }) {
  const [items, setItems] = useState<Upcoming[] | null>(null);

  useEffect(() => {
    if (bots.length === 0) {
      setItems([]);
      return;
    }
    let alive = true;
    Promise.allSettled(bots.map((bot) => rpc.routines.list({ botId: bot.id }))).then(
      (results) => {
        if (!alive) return;
        const next: Upcoming[] = [];
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          const bot = bots[index];
          for (const routine of result.value) {
            if (!routine.active || !routine.nextRunAt) continue;
            next.push({
              id: routine.id,
              name: routine.name,
              botId: routine.botId,
              botName: bot?.name ?? "",
              nextRunAt: routine.nextRunAt,
            });
          }
        });
        next.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
        setItems(next.slice(0, 4));
      },
    );
    return () => {
      alive = false;
    };
  }, [bots]);

  return (
    <BuiCard className="p-5">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <CalendarClock size={16} className="text-[var(--rk-accent)]" aria-hidden="true" />À venir
      </h3>
      {items === null ? (
        <p role="status" className="text-sm text-[var(--rk-muted)]">
          Chargement…
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--rk-muted)]">Aucune routine programmée.</p>
      ) : (
        <ul className="grid gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/app/${item.botId}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--rk-surface)]"
              >
                <span className="w-24 shrink-0 text-xs font-medium tabular-nums">
                  {upcomingTime(item.nextRunAt)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-xs text-[var(--rk-muted)]">
                    {item.botName}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </BuiCard>
  );
}

/* ------------------------------------------------------------------------- */
/* Dépense des 7 derniers jours                                               */
/* ------------------------------------------------------------------------- */

type Spend = { total: number; unpriced: number; top: { label: string; cost: number } | null };

/**
 * Dépense estimée sur sept jours glissants.
 *
 * Les crédits disent combien il reste ; ce chiffre dit à quelle vitesse on
 * consomme, et c'est lui qui trahit un bot qui s'emballe. Le calcul est celui
 * du tableau de consommation — `usage.byModel`, borné par `since` — pour que
 * les deux chiffres tombent juste l'un avec l'autre. `usage.list` ne s'y prête
 * pas : il s'arrête aux cent derniers enregistrements, quand une semaine en
 * compte plusieurs centaines.
 */
export function WeeklySpendCard() {
  const [spend, setSpend] = useState<Spend | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    rpc.usage
      .byModel({ since })
      .then((rows) => {
        if (!alive) return;
        let total = 0;
        let unpriced = 0;
        let top: Spend["top"] = null;
        for (const row of rows) {
          if (row.estimatedCost === null) {
            unpriced += 1;
            continue;
          }
          total += row.estimatedCost;
          if (!top || row.estimatedCost > top.cost) top = { label: row.label, cost: row.estimatedCost };
        }
        setSpend({ total, unpriced, top });
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const usd = (value: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" }).format(value);

  return (
    <BuiCard className="p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Wallet size={16} className="text-[var(--rk-accent)]" aria-hidden="true" />
          Dépense sur 7 jours
        </span>
        <span className="text-xs text-[var(--rk-muted)]">Estimation</span>
      </div>
      {error ? (
        <p className="my-3 text-sm text-[var(--rk-muted)]">Consommation indisponible pour l’instant.</p>
      ) : spend === null ? (
        <p role="status" className="my-3 text-sm text-[var(--rk-muted)]">
          Calcul…
        </p>
      ) : (
        <>
          <p className="mt-3 text-3xl font-semibold tracking-tight">≈ {usd(spend.total)}</p>
          <p className="mt-1 text-xs text-[var(--rk-muted)]">
            {spend.top
              ? `Surtout ${spend.top.label} (${usd(spend.top.cost)})`
              : "Aucune dépense chiffrable cette semaine"}
          </p>
          {spend.unpriced > 0 ? (
            <p className="mt-2 text-xs text-[var(--rk-muted)]">
              {spend.unpriced} modèle{spend.unpriced > 1 ? "s" : ""} sans prix connu, exclu
              {spend.unpriced > 1 ? "s" : ""} du total.
            </p>
          ) : null}
        </>
      )}
    </BuiCard>
  );
}
