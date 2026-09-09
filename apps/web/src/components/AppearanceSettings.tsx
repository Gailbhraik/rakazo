import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { ACCENT_HUES, applyTheme, readTheme, type ThemeMode, writeTheme } from "../lib/theme";

/** Choix du thème et de la couleur d'accent, appliqué immédiatement. */
export function AppearanceSettings() {
  const { t } = useLingui();
  const [choice, setChoice] = useState(() => readTheme());

  function update(next: typeof choice) {
    setChoice(next);
    writeTheme(next);
    applyTheme(next);
  }

  const modes: Array<{ value: ThemeMode; label: string }> = [
    { value: "dark", label: t`Dark` },
    { value: "light", label: t`Light` },
    { value: "system", label: t`System` },
  ];

  return (
    <div
      data-testid="appearance-settings"
      className="mt-5 rounded-[14px] border border-[var(--rk-hairline-strong)] bg-[var(--rk-panel)] px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
        <Trans>Appearance</Trans>
      </h3>

      <div className="mt-3 flex gap-2">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            aria-pressed={choice.mode === mode.value}
            onClick={() => update({ ...choice, mode: mode.value })}
            className={`flex-1 rounded-[11px] border px-3 py-2 text-[14px] ${
              choice.mode === mode.value
                ? "border-[var(--rk-accent)] bg-[var(--rk-surface)] text-[var(--rk-ink)]"
                : "border-[var(--rk-hairline-strong)] text-[var(--rk-muted)] hover:text-[var(--rk-ink)]"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <p className="mt-4 text-[13px] text-[var(--rk-muted)]">
        <Trans>Accent color</Trans>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {ACCENT_HUES.map((hue) => (
          <button
            key={hue}
            type="button"
            aria-label={t`Accent hue ${hue}`}
            aria-pressed={choice.accentHue === hue}
            onClick={() => update({ ...choice, accentHue: hue })}
            style={{ background: `hsl(${hue} 72% 55%)` }}
            className={`h-7 w-7 rounded-full transition ${
              choice.accentHue === hue
                ? "ring-2 ring-[var(--rk-ink)] ring-offset-2 ring-offset-[var(--rk-panel)]"
                : "hover:scale-110"
            }`}
          />
        ))}
      </div>

      <p className="mt-3 text-[12.5px] text-[var(--rk-muted-2)]">
        <Trans>Kept per browser: the right theme depends on the screen you are reading from.</Trans>
      </p>
    </div>
  );
}
