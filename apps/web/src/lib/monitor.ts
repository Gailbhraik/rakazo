/**
 * Accès au service de supervision de l'hôte (`infra/monitoring/host-monitor.py`).
 *
 * Module à part plutôt qu'export de `SystemMonitorOverlay` : l'accueil en a
 * besoin, et l'importer depuis la fenêtre embarquerait tout son code dans le
 * morceau de l'accueil, rendant inutile son chargement différé.
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
export function monitorBase(): string {
  try {
    const override = localStorage.getItem("rk.monitor.base");
    if (override) return override.replace(/\/+$/, "");
  } catch {
    // Navigation privée, stockage refusé : on retombe sur la déduction.
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${MONITOR_PORT}`;
}

/** Relevé instantané, tel que le sert `/api/metrics` — seuls les champs lus ici. */
export type HostSnapshot = {
  ready: boolean;
  now?: {
    at: number;
    cpu: number;
    memory: { percent: number };
    temps: Partial<Record<"apu" | "ssd" | "batterie" | "boitier", number>>;
    battery: { capacity: number | null; on_ac: boolean | null };
    disk: Record<string, { percent: number; free: number }>;
  };
  services?: Record<string, { ok: boolean; code: number | null; ms: number | null }>;
};
