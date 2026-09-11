import { Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Relevés matériels de la machine qui héberge l'instance.
 *
 * Les mesures ne viennent pas de l'API : elles viennent d'un service de
 * supervision distinct, qui lit `/proc` et `/sys` sur l'hôte. L'API tourne en
 * conteneur et n'y a donc pas accès — elle ne verrait que les limites de son
 * propre cgroup, pas la machine.
 *
 * Ce service est optionnel. Une instance qui ne l'a pas installé voit un
 * message le disant, jamais une erreur : la fenêtre s'ouvre et explique.
 */

/** Port du service de supervision, sur l'hôte qui sert déjà l'interface. */
const MONITOR_PORT = 8444;
const POLL_MS = 2000;

/**
 * Adresse du service, déduite de l'origine courante.
 *
 * Une valeur figée à la compilation ne conviendrait pas : le même bundle sert
 * l'accès local et l'accès par le tailnet, sous deux noms d'hôte différents.
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

type Sample = {
  at: number;
  cpu: number;
  cores: number[];
  load: number[];
  uptime: number;
  memory: {
    total: number;
    used: number;
    available: number;
    percent: number;
    swap_total: number;
    swap_used: number;
  };
  temps: Partial<Record<"apu" | "ssd" | "batterie" | "boitier", number>>;
  fan: number | null;
  gpu: {
    busy: number | null;
    vram_used: number | null;
    vram_total: number | null;
    vram_percent: number | null;
    watts: number | null;
    clock_mhz: number | null;
  };
  battery: {
    capacity: number | null;
    status: string | null;
    watts: number | null;
    on_ac: boolean | null;
  };
  disk: Record<string, { total: number; used: number; free: number; percent: number }>;
  net: { rx: number; tx: number };
};

type Metrics = {
  ready: boolean;
  host?: string;
  now?: Sample;
  history?: Record<"cpu" | "memory" | "gpu" | "apu" | "rx" | "tx", number[]>;
  containers?: { name: string; cpu: string; memory: string; mem_percent: string }[];
  services?: Record<string, { ok: boolean; code: number | null; ms: number | null }>;
};

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const units = ["o", "Kio", "Mio", "Gio", "Tio"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} j ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Courbe d'historique. Le tracé est mis à l'échelle du maximum observé. */
function Sparkline({ values, max }: { values: number[] | undefined; max?: number }) {
  if (!values || values.length < 2) return null;
  const ceiling = Math.max(max ?? 0, ...values) || 1;
  const step = 100 / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(2)},${(32 - (value / ceiling) * 30).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="mt-2 block h-8 w-full"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--rk-accent)"
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Meter({ percent }: { percent: number | null | undefined }) {
  const width = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-[var(--rk-n70)]">
      <div className="h-full rounded-full bg-[var(--rk-accent)]" style={{ width: `${width}%` }} />
    </div>
  );
}

function Card({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--rk-n70)] bg-[var(--rk-n89)] px-3.5 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--rk-n35)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Reading({ value, unit, note }: { value: React.ReactNode; unit?: string; note?: React.ReactNode }) {
  return (
    <>
      <p className="text-[24px] leading-none tabular-nums text-[var(--rk-n08)]">
        {value}
        {unit ? <span className="ml-1 text-[13px] text-[var(--rk-n35)]">{unit}</span> : null}
      </p>
      {note ? <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--rk-n29)]">{note}</p> : null}
    </>
  );
}

export function SystemMonitorOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const base = useRef(monitorBase());

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    const controllers = new Set<AbortController>();

    async function poll() {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), POLL_MS * 2);
      try {
        const response = await fetch(`${base.current}/api/metrics`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as Metrics;
        if (!live) return;
        setMetrics(payload);
        setUnreachable(false);
      } catch {
        // Un relevé manqué n'efface pas le précédent : l'affichage se figerait
        // à chaque hoquet du réseau. Seul l'échec initial signale l'absence.
        if (live) setUnreachable((was) => (metrics ? was : true));
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(interval);
      for (const controller of controllers) controller.abort();
    };
    // `metrics` n'est lu que pour distinguer le premier échec des suivants ;
    // le relire à chaque relevé relancerait la boucle sans cesse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = metrics?.now;
  const history = metrics?.history;
  const alerts: string[] = [];
  if (now) {
    if (now.battery.on_ac === false) {
      alerts.push(
        t`Running on battery (${now.battery.capacity ?? "?"}%) — the host will shut down when it empties.`,
      );
    }
    for (const [name, entry] of Object.entries(now.disk)) {
      if (entry.percent >= 95) {
        alerts.push(t`Disk ${name} is ${entry.percent}% full — ${formatBytes(entry.free)} left.`);
      }
    }
    if (now.memory.percent >= 92) alerts.push(t`Memory at ${now.memory.percent}%.`);
    if ((now.temps.apu ?? 0) >= 90) alerts.push(t`CPU package at ${now.temps.apu}°C.`);
  }
  for (const [name, probe] of Object.entries(metrics?.services ?? {})) {
    if (!probe.ok) alerts.push(t`${name} is not responding.`);
  }

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
        className="flex max-h-[84vh] w-full max-w-[720px] flex-col rounded-2xl border border-[var(--rk-n56)] bg-[var(--rk-n92)] shadow-[0_28px_70px_rgba(0,0,0,.6)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--rk-n70)] px-5 py-4">
          <h2 id="system-monitor-title" className="text-[16px] text-[var(--rk-n08)]">
            <Trans>System monitor</Trans>
            {metrics?.host ? (
              <span className="ml-2 text-[13px] text-[var(--rk-n35)]">{metrics.host}</span>
            ) : null}
          </h2>
          <button
            type="button"
            aria-label={t`Close`}
            onClick={onClose}
            className="text-[var(--rk-n29)] hover:text-[var(--rk-n08)]"
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {unreachable ? (
            <div className="rounded-xl border border-[var(--rk-n70)] bg-[var(--rk-n89)] px-4 py-3.5">
              <p className="text-[14px] text-[var(--rk-n08)]">
                <Trans>No monitoring service on this host.</Trans>
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--rk-n29)]">
                <Trans>
                  Readings come from a small service that reads the host's sensors, which the
                  containers cannot see on their own. It is expected at{" "}
                  <code className="text-[var(--rk-n08)]">{base.current}</code>.
                </Trans>
              </p>
            </div>
          ) : null}

          {!now && !unreachable ? (
            <p className="text-[13.5px] text-[var(--rk-n29)]">
              <Trans>Taking the first reading…</Trans>
            </p>
          ) : null}

          {alerts.length ? (
            <div className="mb-3.5 grid gap-2">
              {alerts.map((message) => (
                <p
                  key={message}
                  role="alert"
                  className="rounded-xl border border-[var(--rk-n70)] border-l-[3px] border-l-[var(--rk-accent)] bg-[var(--rk-n89)] px-3.5 py-2.5 text-[13px] text-[var(--rk-n08)]"
                >
                  {message}
                </p>
              ))}
            </div>
          ) : null}

          {now ? (
            <>
              <p className="mb-3 text-[12px] tabular-nums text-[var(--rk-n35)]">
                <Trans>
                  Reading {new Date(now.at * 1000).toLocaleTimeString()} · up{" "}
                  {formatUptime(now.uptime)}
                </Trans>
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <Card title={<Trans>Processor</Trans>}>
                  <Reading
                    value={now.cpu.toFixed(0)}
                    unit="%"
                    note={<Trans>load {now.load.join(" · ")}</Trans>}
                  />
                  <Sparkline values={history?.cpu} max={100} />
                  <div className="mt-2 flex gap-[3px]">
                    {now.cores.map((core, index) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: l'indice EST l'identité du cœur
                        key={index}
                        title={`${core} %`}
                        className="relative h-6 flex-1 overflow-hidden rounded-[2px] bg-[var(--rk-n70)]"
                      >
                        <div
                          className="absolute bottom-0 left-0 right-0 rounded-[2px] bg-[var(--rk-accent)]"
                          style={{ height: `${Math.min(100, core)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                </Card>

                <Card title={<Trans>Memory</Trans>}>
                  <Reading
                    value={now.memory.percent.toFixed(0)}
                    unit="%"
                    note={`${formatBytes(now.memory.used)} / ${formatBytes(now.memory.total)}`}
                  />
                  <Meter percent={now.memory.percent} />
                  <Sparkline values={history?.memory} max={100} />
                  {now.memory.swap_total ? (
                    <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--rk-n29)]">
                      <Trans>
                        swap {formatBytes(now.memory.swap_used)} /{" "}
                        {formatBytes(now.memory.swap_total)}
                      </Trans>
                    </p>
                  ) : null}
                </Card>

                <Card title={<Trans>Graphics</Trans>}>
                  <Reading
                    value={now.gpu.busy ?? "—"}
                    unit="%"
                    note={[
                      now.gpu.clock_mhz ? `${now.gpu.clock_mhz} MHz` : null,
                      now.gpu.watts !== null ? `${now.gpu.watts} W` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                  <Sparkline values={history?.gpu} max={100} />
                  {now.gpu.vram_percent !== null ? (
                    <>
                      <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--rk-n29)]">
                        <Trans>
                          VRAM {formatBytes(now.gpu.vram_used)} /{" "}
                          {formatBytes(now.gpu.vram_total)}
                        </Trans>
                      </p>
                      <Meter percent={now.gpu.vram_percent} />
                    </>
                  ) : null}
                </Card>

                <Card title={<Trans>Temperatures</Trans>}>
                  <Reading
                    value={now.temps.apu ?? "—"}
                    unit="°C"
                    note={[
                      now.temps.ssd !== undefined ? `SSD ${now.temps.ssd} °C` : null,
                      now.temps.batterie !== undefined ? `${now.temps.batterie} °C` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                  <Sparkline values={history?.apu} max={100} />
                  <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--rk-n29)]">
                    <Trans>fan {now.fan === null ? "—" : `${now.fan} rpm`}</Trans>
                  </p>
                </Card>

                <Card title={<Trans>Power</Trans>}>
                  <Reading
                    value={now.battery.capacity ?? "—"}
                    unit="%"
                    note={[
                      now.battery.on_ac ? t`on AC` : t`on battery`,
                      now.battery.watts ? `${now.battery.watts} W` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                  <Meter percent={now.battery.capacity} />
                </Card>

                <Card title={<Trans>Network</Trans>}>
                  <p className="text-[19px] leading-tight tabular-nums text-[var(--rk-n08)]">
                    ↓ {formatBytes(now.net.rx)}/s
                  </p>
                  <p className="text-[19px] leading-tight tabular-nums text-[var(--rk-n08)]">
                    ↑ {formatBytes(now.net.tx)}/s
                  </p>
                  <Sparkline values={history?.rx} />
                </Card>

                {Object.entries(now.disk).map(([name, entry]) => (
                  <Card key={name} title={<Trans>Storage {name}</Trans>}>
                    <Reading
                      value={entry.percent.toFixed(0)}
                      unit="%"
                      note={<Trans>{formatBytes(entry.free)} free</Trans>}
                    />
                    <Meter percent={entry.percent} />
                  </Card>
                ))}

                {metrics?.services && Object.keys(metrics.services).length ? (
                  <Card title={<Trans>Services</Trans>}>
                    <ul className="grid gap-1.5">
                      {Object.entries(metrics.services).map(([name, probe]) => (
                        <li
                          key={name}
                          className="flex items-center gap-2 text-[13px] text-[var(--rk-n08)]"
                        >
                          <span
                            aria-hidden="true"
                            className="h-2 w-2 rounded-full"
                            style={{
                              background: probe.ok ? "#4ECB71" : "var(--rk-accent)",
                            }}
                          />
                          <span className="flex-1">{name}</span>
                          <span className="tabular-nums text-[var(--rk-n29)]">
                            {probe.ms === null ? t`unreachable` : `${probe.ms} ms`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </div>

              {metrics?.containers?.length ? (
                <div className="mt-3 rounded-xl border border-[var(--rk-n70)] bg-[var(--rk-n89)] px-3.5 py-3">
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--rk-n35)]">
                    <Trans>Containers</Trans>
                  </h3>
                  <div className="rk-scroll overflow-x-auto">
                    <table className="w-full min-w-[380px] border-collapse text-[13px]">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-[0.05em] text-[var(--rk-n35)]">
                          <th className="border-b border-[var(--rk-n70)] px-1 py-1.5 text-start font-semibold">
                            <Trans>Name</Trans>
                          </th>
                          <th className="border-b border-[var(--rk-n70)] px-1 py-1.5 text-end font-semibold">
                            <Trans>CPU</Trans>
                          </th>
                          <th className="border-b border-[var(--rk-n70)] px-1 py-1.5 text-end font-semibold">
                            <Trans>Memory</Trans>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrics.containers.map((container) => (
                          <tr key={container.name} className="text-[var(--rk-n08)]">
                            <td className="border-b border-[var(--rk-n70)] px-1 py-1.5">
                              {container.name}
                            </td>
                            <td className="border-b border-[var(--rk-n70)] px-1 py-1.5 text-end tabular-nums">
                              {container.cpu}
                            </td>
                            <td className="border-b border-[var(--rk-n70)] px-1 py-1.5 text-end tabular-nums text-[var(--rk-n29)]">
                              {container.memory}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
