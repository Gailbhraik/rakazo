export type CurrentWeather = {
  temperature: number;
  feelsLike: number;
  wind: number;
  code: number;
  time: string;
};
/** Round to approximately one kilometre; coordinates are never persisted by the app. */
export async function fetchLocalWeather(
  latitude: number,
  longitude: number,
  signal: AbortSignal,
): Promise<CurrentWeather> {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(2),
    longitude: longitude.toFixed(2),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    timezone: "auto",
    forecast_days: "1",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("Weather unavailable");
  const body = await response.json();
  const current = body.current;
  if (
    !current ||
    ![
      current.temperature_2m,
      current.apparent_temperature,
      current.weather_code,
      current.wind_speed_10m,
    ].every((value) => typeof value === "number" && Number.isFinite(value)) ||
    typeof current.time !== "string"
  )
    throw new Error("Invalid weather");
  return {
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    wind: current.wind_speed_10m,
    code: current.weather_code,
    time: current.time,
  };
}
export function weatherLabel(code: number): string {
  if (code === 0) return "Ciel dégagé";
  if ([1, 2, 3].includes(code)) return "Nuageux";
  if ([45, 48].includes(code)) return "Brouillard";
  if ([51, 53, 55, 56, 57].includes(code)) return "Bruine";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Pluie";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Neige";
  if ([95, 96, 99].includes(code)) return "Orage";
  return "Météo locale";
}
