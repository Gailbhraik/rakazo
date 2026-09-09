/**
 * Thème d'affichage : clair, sombre, ou celui du système.
 *
 * Le choix est gardé par navigateur plutôt que sur le serveur : c'est une
 * préférence d'affichage, qui dépend de l'écran et de la lumière ambiante. Le
 * même compte peut vouloir le sombre sur un portable le soir et le clair sur un
 * téléphone en plein jour.
 */

export type ThemeMode = "system" | "light" | "dark";

export type ThemeChoice = {
  mode: ThemeMode;
  /** Teinte de l'accent, en degrés. 358 est le rouge d'origine. */
  accentHue: number;
};

const STORAGE_KEY = "rk-theme";
export const DEFAULT_THEME: ThemeChoice = { mode: "dark", accentHue: 358 };

/** Teintes proposées, réparties sur le cercle pour rester distinctes. */
export const ACCENT_HUES = [358, 22, 45, 140, 190, 215, 265, 320];

export function readTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<ThemeChoice>;
    const mode: ThemeMode =
      parsed.mode === "light" || parsed.mode === "dark" || parsed.mode === "system"
        ? parsed.mode
        : DEFAULT_THEME.mode;
    const hue =
      typeof parsed.accentHue === "number" && Number.isFinite(parsed.accentHue)
        ? ((parsed.accentHue % 360) + 360) % 360
        : DEFAULT_THEME.accentHue;
    return { mode, accentHue: hue };
  } catch {
    // Navigation privée, stockage refusé : le thème par défaut vaut mieux qu'un écran blanc.
    return DEFAULT_THEME;
  }
}

export function writeTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Le thème reste appliqué pour la session, simplement non mémorisé.
  }
}

function prefersLight(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  const light = choice.mode === "light" || (choice.mode === "system" && prefersLight());
  if (light) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  root.style.setProperty("--rk-accent-h", String(choice.accentHue));
  // La barre d'adresse mobile et le fond de la page doivent suivre, sans quoi
  // un liseré sombre subsiste en haut de l'écran en thème clair.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#faf9f8" : "#060505");
}

/** Applique le thème mémorisé, et suit le système tant que « system » est choisi. */
export function startTheme(): void {
  applyTheme(readTheme());
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    const choice = readTheme();
    if (choice.mode === "system") applyTheme(choice);
  });
}
