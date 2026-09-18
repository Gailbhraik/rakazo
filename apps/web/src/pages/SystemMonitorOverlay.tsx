import { Trans, useLingui } from "@lingui/react/macro";
import { ExternalLink, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { monitorBase } from "../lib/monitor";

/**
 * Pages rendues par le service de supervision de l'hôte, montrées dans l'interface.
 *
 * Les mesures ne peuvent pas venir de l'API : elle tourne en conteneur et ne
 * verrait que les limites de son propre cgroup, pas la machine. Elles viennent
 * d'un service posé à côté, qui lit `/proc`, `/sys`, `podman stats` et les
 * transcriptions locales de Claude Code — voir `infra/monitoring/host-monitor.py`.
 *
 * Ce service rend déjà ses propres pages, complètes et adaptées au téléphone :
 * on les incorpore plutôt que de redessiner les mêmes cartes ici. Une seule
 * mise en page à maintenir, et rien à reconstruire côté interface quand un
 * relevé s'ajoute. La contrepartie est que ces pages gardent leur palette
 * propre et ne suivent pas la couleur d'accent choisie dans les réglages.
 *
 * Le service est optionnel : une instance qui ne l'a pas installé lit ce qui
 * lui manque, plutôt que de contempler un cadre vide.
 */

type Reachability = "checking" | "up" | "absent";

/**
 * Cadre commun aux pages du service : sonde, en-tête, lien sortant, fermeture.
 *
 * `path` désigne la page à incorporer — la racine pour les relevés matériels,
 * `/claude` pour la consommation. Le reste est identique, et le rester évite
 * d'avoir à corriger deux fois le même défaut.
 */
function MonitorFrame({
  path,
  title,
  absence,
  onClose,
}: {
  path: string;
  title: ReactNode;
  absence: ReactNode;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const base = useRef(monitorBase());
  const [state, setState] = useState<Reachability>("checking");
  const url = `${base.current}${path}`;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Un cadre incorporé ne dit pas s'il a chargé : `onError` ne se déclenche
    // pas sur une origine tierce injoignable. On sonde donc le service avant
    // de l'afficher, pour pouvoir expliquer son absence au lieu de laisser un
    // rectangle vide.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    fetch(`${base.current}/healthz`, { signal: controller.signal, cache: "no-store" })
      .then((response) => setState(response.ok ? "up" : "absent"))
      .catch(() => setState("absent"))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-frame-title"
        onPointerDown={(event) => event.stopPropagation()}
        className="flex h-[84vh] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border border-[var(--rk-n56)] bg-[var(--rk-n92)] shadow-[0_28px_70px_rgba(0,0,0,.6)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--rk-n70)] px-5 py-4">
          <h2 id="monitor-frame-title" className="flex-1 text-[16px] text-[var(--rk-n08)]">
            {title}
          </h2>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-[13px] text-[var(--rk-n29)] hover:text-[var(--rk-n08)]"
          >
            <ExternalLink size={14} strokeWidth={1.8} />
            <Trans>Open in a tab</Trans>
          </a>
          <button
            type="button"
            aria-label={t`Close`}
            onClick={onClose}
            className="text-[var(--rk-n29)] hover:text-[var(--rk-n08)]"
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        {state === "absent" ? <div className="px-5 py-4">{absence}</div> : null}

        {state === "checking" ? (
          <p className="px-5 py-4 text-[13.5px] text-[var(--rk-n29)]">
            <Trans>Reaching the monitoring service…</Trans>
          </p>
        ) : null}

        {state === "up" ? (
          <iframe
            src={url}
            title={t`Monitoring`}
            referrerPolicy="no-referrer"
            className="min-h-0 flex-1 border-0 bg-[var(--rk-n92)]"
          />
        ) : null}
      </div>
    </div>
  );
}

export function SystemMonitorOverlay({ onClose }: { onClose: () => void }) {
  return (
    <MonitorFrame
      path=""
      onClose={onClose}
      title={<Trans>System monitor</Trans>}
      absence={
        <>
          <p className="text-[14px] text-[var(--rk-n08)]">
            <Trans>No monitoring service on this host.</Trans>
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
            <Trans>
              Readings come from a small service that reads the host's sensors, which the containers
              cannot see on their own. See infra/monitoring in the repository.
            </Trans>
          </p>
        </>
      }
    />
  );
}

/**
 * Consommation de Claude Code sur cette machine.
 *
 * Elle ne peut pas venir de la base : celle-ci n'enregistre que les appels des
 * bots, qui passent par un autre fournisseur. La seule source locale est la
 * transcription que Claude Code écrit par session, d'où la lecture côté hôte.
 */
export function ClaudeUsageOverlay({ onClose }: { onClose: () => void }) {
  return (
    <MonitorFrame
      path="/claude"
      onClose={onClose}
      title={<Trans>Claude usage</Trans>}
      absence={
        <>
          <p className="text-[14px] text-[var(--rk-n08)]">
            <Trans>No monitoring service on this host.</Trans>
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
            <Trans>
              Usage is read from the Claude Code transcripts stored on the host, which the
              containers cannot see on their own. See infra/monitoring in the repository.
            </Trans>
          </p>
        </>
      }
    />
  );
}

/**
 * Consommation OpenRouter détaillée : par jour, modèle, hébergeur et clé.
 *
 * Ce détail n'est servi qu'avec une clé de gestion OpenRouter, que l'API
 * d'Ashitaka n'a pas — elle ne détient que des clés d'inférence. Le service de
 * l'hôte la lit dans un fichier posé par l'utilisateur, comme celle de Finnhub,
 * et sa page explique comment l'installer quand elle manque.
 */
export function OpenRouterUsageOverlay({ onClose }: { onClose: () => void }) {
  return (
    <MonitorFrame
      path="/openrouter"
      onClose={onClose}
      title={<Trans>OpenRouter usage</Trans>}
      absence={
        <>
          <p className="text-[14px] text-[var(--rk-n08)]">
            <Trans>No monitoring service on this host.</Trans>
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
            <Trans>
              The detailed usage is read by the host service with an OpenRouter management key kept
              on the host. See infra/monitoring in the repository.
            </Trans>
          </p>
        </>
      }
    />
  );
}

/**
 * Portefeuille boursier : une liste de positions saisies à la main, servie par
 * le même service de l'hôte.
 *
 * Elle y vit plutôt que dans l'API parce qu'elle garde le portefeuille dans un
 * simple fichier du Deck, sans migration de base, et parce que ce service est
 * déjà joignable depuis l'interface — c'est lui que ce cadre sait incorporer.
 */
export function PortfolioOverlay({ onClose }: { onClose: () => void }) {
  return (
    <MonitorFrame
      path="/portfolio"
      onClose={onClose}
      title={<Trans>Portfolio</Trans>}
      absence={
        <>
          <p className="text-[14px] text-[var(--rk-n08)]">
            <Trans>No monitoring service on this host.</Trans>
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
            <Trans>
              The portfolio is served by the host service, which keeps it in a file on the host. See
              infra/monitoring in the repository.
            </Trans>
          </p>
        </>
      }
    />
  );
}
