import { CloudSun, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type CurrentWeather, fetchLocalWeather, weatherLabel } from "../lib/adapters/open-meteo";
export function WeatherWidget() {
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function locate() {
    if (busy) return;
    setError("");
    if (!window.isSecureContext) {
      setError("La localisation nécessite une adresse HTTPS sur ton téléphone.");
      return;
    }
    if (!navigator.geolocation) {
      setError("La localisation n’est pas disponible dans ce navigateur.");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (controller.signal.aborted) return;
        try {
          const result = await fetchLocalWeather(
            position.coords.latitude,
            position.coords.longitude,
            AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          );
          if (!controller.signal.aborted) setWeather(result);
        } catch {
          if (!controller.signal.aborted)
            setError("Météo indisponible pour le moment. Réessaie plus tard.");
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      },
      (failure) => {
        if (controller.signal.aborted) return;
        setBusy(false);
        setError(
          failure.code === 1
            ? "Localisation refusée. Tu peux l’autoriser dans les réglages du site."
            : "Position introuvable. Réessaie dans un instant.",
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }
  return (
    <section
      aria-label="Météo locale"
      className="mb-6 rounded-2xl border border-[var(--rk-hairline-strong)] bg-[var(--rk-panel)] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <CloudSun size={23} className="shrink-0 text-[var(--rk-muted)]" />
        <div className="min-w-0 flex-1">
          {weather ? (
            <>
              <p className="text-sm">
                <strong>{Math.round(weather.temperature)} °C</strong> · {weatherLabel(weather.code)}
              </p>
              <p className="text-xs text-[var(--rk-muted)]">
                Ressenti {Math.round(weather.feelsLike)} °C · vent {Math.round(weather.wind)} km/h ·{" "}
                {weather.time.slice(11, 16)}
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--rk-muted)]">La météo autour de toi</p>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={locate}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-[var(--rk-accent)] disabled:opacity-50"
        >
          <MapPin size={13} />
          {busy ? "Chargement…" : weather ? "Actualiser la météo" : "Utiliser ma position"}
        </button>
      </div>
      {error && (
        <p role="status" className="mt-2 text-xs text-[var(--rk-muted)]">
          {error}
        </p>
      )}
      <p className="mt-2 text-[11px] text-[var(--rk-muted)]">
        {weather ? "Données : " : "Avec ton accord, position approximative envoyée à "}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline">
          Open-Meteo
        </a>
        {weather ? "." : ". Position non enregistrée par l’application."}
      </p>
    </section>
  );
}
