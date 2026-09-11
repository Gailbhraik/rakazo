import { Trans, useLingui } from "@lingui/react/macro";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * État de la machine hôte, montré dans l'interface.
 *
 * Les mesures ne peuvent pas venir de l'API : elle tourne en conteneur et ne
 * verrait que les limites de son propre cgroup, pas la machine. Elles viennent
 * d'un service de supervision posé à côté, qui lit `/proc`, `/sys` et
 * `podman stats` — voir `infra/monitoring/host-monitor.py`.
 *
 * Ce service rend déjà sa propre page, complète et adaptée au téléphone : on
 * l'incorpore plutôt que de redessiner les mêmes cartes ici. Une seule mise en
 * page à maintenir, et rien à reconstruire côté interface quand un relevé
 * s'ajoute. La contrepartie est que cette page garde sa palette propre et ne
 * suit pas la couleur d'accent choisie dans les réglages.
 *
 * Le service est optionnel : une instance qui ne l'a pas installé lit ce qui
 * lui manque, plutôt que de contempler un cadre vide.
 */

/** Port du service de supervision, sur l'hôte qui sert déjà l'interface. */
const MONITOR_PORT = 8444;

/**
 * Adresse du service, déduite de l'origine courante.
 *
 * Une valeur figée à la compilation ne conviendrait pas : le même bundle sert
 * l'accès local et l'accès distant, sous deux noms d'hôte différents.
 * `localStorage` permet de pointer ailleurs quand la supervision ne tourne pas
 * sur la même machine que l'interface.
 */
function monitorBase(): string {
  try {
    const override = localStorage.getItem("rk.monitor.base");
    if (override) return override.replace(/\/+$/, "");
  } catch {
    // Navigation privée, stockage refusé : on retombe sur la déduction.
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${MONITOR_PORT}`;
}

type Reachability = "checking" | "up" | "absent";

export function SystemMonitorOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const base = useRef(monitorBase());
  const [state, setState] = useState<Reachability>("checking");

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
        aria-labelledby="system-monitor-title"
        onPointerDown={(event) => event.stopPropagation()}
        className="flex h-[84vh] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border border-[var(--rk-n56)] bg-[var(--rk-n92)] shadow-[0_28px_70px_rgba(0,0,0,.6)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--rk-n70)] px-5 py-4">
          <h2 id="system-monitor-title" className="flex-1 text-[16px] text-[var(--rk-n08)]">
            <Trans>System monitor</Trans>
          </h2>
          <a
            href={base.current}
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

        {state === "absent" ? (
          <div className="px-5 py-4">
            <p className="text-[14px] text-[var(--rk-n08)]">
              <Trans>No monitoring service on this host.</Trans>
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
              <Trans>
                Readings come from a small service that reads the host's sensors, which the
                containers cannot see on their own. It is expected at{" "}
                <code className="text-[var(--rk-n08)]">{base.current}</code> — see
                infra/monitoring in the repository.
              </Trans>
            </p>
          </div>
        ) : null}

        {state === "checking" ? (
          <p className="px-5 py-4 text-[13.5px] text-[var(--rk-n29)]">
            <Trans>Reaching the monitoring service…</Trans>
          </p>
        ) : null}

        {state === "up" ? (
          <iframe
            src={base.current}
            title={t`System monitor`}
            referrerPolicy="no-referrer"
            className="min-h-0 flex-1 border-0 bg-[var(--rk-n92)]"
          />
        ) : null}
      </div>
    </div>
  );
}
