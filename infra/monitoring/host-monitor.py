#!/usr/bin/env python3
"""Supervision du Steam Deck — relevés matériels et état des services.

Bibliothèque standard uniquement : le Deck est un SteamOS dont la racine
redevient immuable à chaque mise à jour, donc rien à installer ici.

Deux cadences de relevé, parce que les sources n'ont pas le même coût :
les fichiers de `/proc` et `/sys` se lisent en une milliseconde, tandis que
`podman stats` demande une à deux secondes. La première tourne toutes les
deux secondes, la seconde toutes les quinze, chacune dans son fil.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DECK_MONITOR_PORT", "9200"))
HOST = os.environ.get("DECK_MONITOR_HOST", "127.0.0.1")
INTERVAL = 2.0
SLOW_INTERVAL = 15.0
HISTORY = 150  # 150 × 2 s = cinq minutes de recul

_lock = threading.Lock()
_state = {"samples": deque(maxlen=HISTORY), "containers": [], "services": {}}


# --- lecture des capteurs ---------------------------------------------------


def _read(path, default=None):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return default


def _read_int(path, default=None):
    raw = _read(path)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _hwmon_paths():
    """Associe chaque puce hwmon à son répertoire.

    Les numéros de hwmon ne sont pas stables d'un démarrage à l'autre : c'est
    le fichier `name` qui identifie la puce, jamais l'indice du chemin.
    """
    found = {}
    base = "/sys/class/hwmon"
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return found
    for entry in entries:
        path = os.path.join(base, entry)
        name = _read(os.path.join(path, "name"))
        if name and name not in found:
            found[name] = path
    return found


_HWMON = _hwmon_paths()


def _cpu_times():
    """Renvoie (total, occupé) pour l'agrégat et chaque cœur."""
    out = {}
    raw = _read("/proc/stat", "")
    for line in raw.splitlines():
        if not line.startswith("cpu"):
            continue
        parts = line.split()
        key = parts[0]
        try:
            values = [int(v) for v in parts[1:11]]
        except ValueError:
            continue
        total = sum(values)
        # `idle` et `iowait` comptent tous deux comme inactivité : un cœur qui
        # attend un disque n'exécute rien.
        idle = values[3] + values[4]
        out[key] = (total, total - idle)
    return out


_prev_cpu = _cpu_times()
_prev_net = None
_prev_net_at = None


def _cpu_percent():
    global _prev_cpu
    now = _cpu_times()
    result = {}
    for key, (total, busy) in now.items():
        prev = _prev_cpu.get(key)
        if not prev:
            continue
        d_total = total - prev[0]
        d_busy = busy - prev[1]
        result[key] = round(100.0 * d_busy / d_total, 1) if d_total > 0 else 0.0
    _prev_cpu = now
    return result


def _meminfo():
    info = {}
    for line in (_read("/proc/meminfo", "") or "").splitlines():
        m = re.match(r"^(\w+):\s+(\d+) kB", line)
        if m:
            info[m.group(1)] = int(m.group(2)) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", 0)
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    return {
        "total": total,
        "used": total - available,
        "available": available,
        "percent": round(100.0 * (total - available) / total, 1) if total else 0.0,
        "swap_total": swap_total,
        "swap_used": swap_total - swap_free,
        "swap_percent": (
            round(100.0 * (swap_total - swap_free) / swap_total, 1) if swap_total else 0.0
        ),
    }


def _net_rates():
    """Débits en octets par seconde, hors interfaces locales et virtuelles."""
    global _prev_net, _prev_net_at
    rx = tx = 0
    for line in (_read("/proc/net/dev", "") or "").splitlines():
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo" or iface.startswith(("veth", "podman", "cni-", "br-", "docker")):
            continue
        fields = rest.split()
        if len(fields) >= 9:
            rx += int(fields[0])
            tx += int(fields[8])
    now = time.monotonic()
    rates = {"rx": 0.0, "tx": 0.0}
    if _prev_net is not None and _prev_net_at is not None:
        elapsed = now - _prev_net_at
        if elapsed > 0:
            rates = {
                "rx": max(0.0, (rx - _prev_net[0]) / elapsed),
                "tx": max(0.0, (tx - _prev_net[1]) / elapsed),
            }
    _prev_net, _prev_net_at = (rx, tx), now
    return rates


def _temperatures():
    temps = {}
    amdgpu = _HWMON.get("amdgpu")
    if amdgpu:
        v = _read_int(os.path.join(amdgpu, "temp1_input"))
        if v is not None:
            temps["apu"] = round(v / 1000.0, 1)
    nvme = _HWMON.get("nvme")
    if nvme:
        v = _read_int(os.path.join(nvme, "temp1_input"))
        if v is not None:
            temps["ssd"] = round(v / 1000.0, 1)
    deck = _HWMON.get("steamdeck_hwmon")
    if deck:
        v = _read_int(os.path.join(deck, "temp1_input"))
        if v is not None:
            temps["batterie"] = round(v / 1000.0, 1)
    v = _read_int("/sys/class/thermal/thermal_zone0/temp")
    if v is not None:
        temps["boitier"] = round(v / 1000.0, 1)
    return temps


def _fan_rpm():
    deck = _HWMON.get("steamdeck_hwmon")
    if not deck:
        return None
    return _read_int(os.path.join(deck, "fan1_input"))


def _gpu():
    busy = _read_int("/sys/class/drm/card0/device/gpu_busy_percent")
    used = _read_int("/sys/class/drm/card0/device/mem_info_vram_used")
    total = _read_int("/sys/class/drm/card0/device/mem_info_vram_total")
    watts = None
    amdgpu = _HWMON.get("amdgpu")
    if amdgpu:
        micro = _read_int(os.path.join(amdgpu, "power1_average"))
        if micro is not None:
            watts = round(micro / 1_000_000.0, 2)
    clock = None
    raw = _read("/sys/class/drm/card0/device/pp_dpm_sclk", "") or ""
    for line in raw.splitlines():
        # La fréquence active est celle que le noyau marque d'une étoile.
        if line.rstrip().endswith("*"):
            m = re.search(r"(\d+)Mhz", line, re.IGNORECASE)
            if m:
                clock = int(m.group(1))
    return {
        "busy": busy,
        "vram_used": used,
        "vram_total": total,
        "vram_percent": round(100.0 * used / total, 1) if used and total else None,
        "watts": watts,
        "clock_mhz": clock,
    }


def _battery():
    base = "/sys/class/power_supply/BAT1"
    capacity = _read_int(os.path.join(base, "capacity"))
    status = _read(os.path.join(base, "status"))
    voltage = _read_int(os.path.join(base, "voltage_now"))
    current = _read_int(os.path.join(base, "current_now"))
    watts = None
    if voltage and current:
        watts = round(voltage / 1e6 * current / 1e6, 2)
    on_ac = _read_int("/sys/class/power_supply/ACAD/online")
    return {
        "capacity": capacity,
        "status": status,
        "watts": watts,
        "on_ac": bool(on_ac) if on_ac is not None else None,
    }


def _disk():
    out = {}
    for label, path in (("home", "/home"), ("racine", "/")):
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            continue
        out[label] = {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": round(100.0 * usage.used / usage.total, 1) if usage.total else 0.0,
        }
    return out


def _sample():
    cpu = _cpu_percent()
    cores = sorted(
        ((k, v) for k, v in cpu.items() if k != "cpu"),
        key=lambda kv: int(kv[0][3:] or 0),
    )
    loadavg = os.getloadavg()
    return {
        "at": time.time(),
        "cpu": cpu.get("cpu", 0.0),
        "cores": [v for _, v in cores],
        "load": [round(x, 2) for x in loadavg],
        "uptime": float((_read("/proc/uptime", "0") or "0").split()[0]),
        "memory": _meminfo(),
        "temps": _temperatures(),
        "fan": _fan_rpm(),
        "gpu": _gpu(),
        "battery": _battery(),
        "disk": _disk(),
        "net": _net_rates(),
    }


# --- relevés lents : conteneurs et services --------------------------------


def _containers():
    """État des conteneurs podman, via une seule invocation formatée.

    `podman stats` est lent (une à deux secondes) et n'expose la mémoire que
    sous forme de texte « 444.7MB / 1.611GB » : on conserve la chaîne telle
    quelle pour l'affichage et on ne convertit que le pourcentage.
    """
    try:
        proc = subprocess.run(
            [
                "podman", "stats", "--no-stream",
                "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
            ],
            capture_output=True, text=True, timeout=25,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[0].strip():
            continue
        rows.append(
            {
                "name": parts[0].strip(),
                "cpu": parts[1].strip(),
                "memory": parts[2].strip(),
                "mem_percent": parts[3].strip(),
            }
        )
    return rows


def _probe(url, timeout=6.0):
    started = time.monotonic()
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    except Exception:
        return {"ok": False, "code": None, "ms": None}
    ms = int((time.monotonic() - started) * 1000)
    # 200 comme 302 disent que le service répond ; seule l'absence de réponse
    # est un échec. Le tableau de bord Hermes redirige vers /login hors session.
    return {"ok": 200 <= code < 400, "code": code, "ms": ms}


def _services():
    return {
        "Ashitaka": _probe("http://127.0.0.1:5173/"),
        "API Ashitaka": _probe("http://127.0.0.1:3100/health"),
        "Hermes": _probe("http://127.0.0.1:9119/login"),
    }


def _fast_loop():
    while True:
        try:
            sample = _sample()
            with _lock:
                _state["samples"].append(sample)
        except Exception:
            pass
        time.sleep(INTERVAL)


def _slow_loop():
    while True:
        try:
            containers = _containers()
            services = _services()
            with _lock:
                _state["containers"] = containers
                _state["services"] = services
        except Exception:
            pass
        time.sleep(SLOW_INTERVAL)


def _payload():
    with _lock:
        samples = list(_state["samples"])
        containers = list(_state["containers"])
        services = dict(_state["services"])
    if not samples:
        return {"ready": False}
    return {
        "ready": True,
        "now": samples[-1],
        "history": {
            "at": [s["at"] for s in samples],
            "cpu": [s["cpu"] for s in samples],
            "memory": [s["memory"]["percent"] for s in samples],
            "gpu": [(s["gpu"]["busy"] or 0) for s in samples],
            "apu": [s["temps"].get("apu") or 0 for s in samples],
            "rx": [s["net"]["rx"] for s in samples],
            "tx": [s["net"]["tx"] for s in samples],
        },
        "containers": containers,
        "services": services,
        "host": os.uname().nodename,
    }


# --- service HTTP -----------------------------------------------------------

PAGE = r"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Steam Deck — supervision</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  :root {
    --bg: #0e0e10; --card: #17171a; --line: #24242a; --ink: #ececee;
    --muted: #8a8a92; --accent: #e0393e; --ok: #3fb950; --warn: #d29922;
    --bad: #e0393e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 16px; -webkit-text-size-adjust: 100%;
  }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .host { color: var(--muted); font-size: 13px; }
  .stamp { margin-left: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .alerts { display: grid; gap: 8px; margin-bottom: 14px; }
  .alert {
    border: 1px solid var(--line); border-left: 3px solid var(--warn);
    background: #1c1a14; border-radius: 8px; padding: 9px 12px; font-size: 13px;
  }
  .alert.bad { border-left-color: var(--bad); background: #1e1415; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 13px 14px; }
  .card h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--muted); margin: 0 0 9px; font-weight: 600;
  }
  .big { font-size: 26px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .big small { font-size: 14px; color: var(--muted); margin-left: 3px; }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .bar { height: 5px; background: #26262c; border-radius: 3px; overflow: hidden; margin-top: 9px; }
  .bar > i { display: block; height: 100%; background: var(--accent); transition: width .4s; }
  svg.spark { display: block; width: 100%; height: 34px; margin-top: 8px; }
  .cores { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; margin-top: 9px; }
  .cores > i { display: block; height: 26px; background: #26262c; border-radius: 2px; position: relative; }
  .cores > i > b { position: absolute; bottom: 0; left: 0; right: 0; background: var(--accent); border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Quatre colonnes ne tiennent pas sur un écran de téléphone : le tableau
     défile dans son propre cadre plutôt que d'élargir la page. */
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .scroll table { min-width: 420px; }
  tr:last-child td { border-bottom: 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
  .wide { grid-column: 1 / -1; }
  .offline { color: var(--bad); }
</style>
</head>
<body>
<header>
  <h1>Steam Deck</h1>
  <span class="host" id="host"></span>
  <span class="stamp" id="stamp">connexion…</span>
</header>
<div class="alerts" id="alerts"></div>
<div class="grid" id="grid"></div>
<script>
const F = {
  bytes(n) {
    if (n === null || n === undefined) return "—";
    const u = ["o", "Kio", "Mio", "Gio", "Tio"];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 1 : 0) + " " + u[i];
  },
  rate(n) { return F.bytes(n) + "/s"; },
  duration(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + " j " + h + " h";
    if (h) return h + " h " + m + " min";
    return m + " min";
  },
};

function spark(values, max) {
  if (!values || values.length < 2) return "";
  const top = Math.max(max || 0, ...values) || 1;
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => (i * step).toFixed(2) + "," + (34 - (v / top) * 32).toFixed(2));
  return '<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none">'
    + '<polyline fill="none" stroke="var(--accent)" stroke-width="1.4"'
    + ' vector-effect="non-scaling-stroke" points="' + pts.join(" ") + '"/></svg>';
}

function card(title, body) { return '<div class="card"><h2>' + title + "</h2>" + body + "</div>"; }
function bar(pct) { return '<div class="bar"><i style="width:' + Math.min(100, pct || 0) + '%"></i></div>'; }

function render(d) {
  if (!d.ready) { document.getElementById("stamp").textContent = "premier relevé en cours…"; return; }
  const n = d.now, h = d.history;
  document.getElementById("host").textContent = n ? d.host : "";
  document.getElementById("stamp").textContent =
    "relevé " + new Date(n.at * 1000).toLocaleTimeString("fr-FR") + " · en service depuis " + F.duration(n.uptime);

  const alerts = [];
  if (n.battery && n.battery.on_ac === false)
    alerts.push(['bad', "Sur batterie — " + n.battery.capacity + " %"
      + (n.battery.watts ? ", " + n.battery.watts + " W consommés" : "")
      + ". Le Deck s'éteindra une fois vide : rebrancher le secteur."]);
  for (const [k, v] of Object.entries(n.disk || {}))
    if (v.percent >= 95) alerts.push(['warn', "Disque « " + k + " » à " + v.percent + " % — " + F.bytes(v.free) + " libres."]);
  if (n.memory && n.memory.percent >= 92)
    alerts.push(['warn', "Mémoire à " + n.memory.percent + " % — risque d'arrêt brutal d'un conteneur."]);
  if (n.temps && n.temps.apu >= 90) alerts.push(['warn', "APU à " + n.temps.apu + " °C."]);
  for (const [name, s] of Object.entries(d.services || {}))
    if (!s.ok) alerts.push(['bad', name + " ne répond pas" + (s.code ? " (code " + s.code + ")" : "") + "."]);
  document.getElementById("alerts").innerHTML =
    alerts.map(([k, t]) => '<div class="alert ' + (k === 'bad' ? 'bad' : '') + '">' + t + "</div>").join("");

  const cards = [];
  cards.push(card("Processeur",
    '<div class="big">' + n.cpu.toFixed(0) + '<small>%</small></div>'
    + '<div class="sub">charge ' + n.load.join(" · ") + "</div>"
    + spark(h.cpu, 100)
    + '<div class="cores">' + n.cores.map(c =>
        '<i title="' + c + ' %"><b style="height:' + Math.min(100, c) + '%"></b></i>').join("") + "</div>"));

  cards.push(card("Mémoire",
    '<div class="big">' + n.memory.percent.toFixed(0) + '<small>%</small></div>'
    + '<div class="sub">' + F.bytes(n.memory.used) + " / " + F.bytes(n.memory.total)
    + " · " + F.bytes(n.memory.available) + " disponibles</div>"
    + bar(n.memory.percent) + spark(h.memory, 100)
    + (n.memory.swap_total ? '<div class="sub">échange ' + F.bytes(n.memory.swap_used)
        + " / " + F.bytes(n.memory.swap_total) + "</div>" : "")));

  const g = n.gpu || {};
  cards.push(card("Graphique",
    '<div class="big">' + (g.busy === null || g.busy === undefined ? "—" : g.busy) + '<small>%</small></div>'
    + '<div class="sub">' + (g.clock_mhz ? g.clock_mhz + " MHz · " : "")
    + (g.watts !== null && g.watts !== undefined ? g.watts + " W" : "") + "</div>"
    + spark(h.gpu, 100)
    + (g.vram_percent !== null && g.vram_percent !== undefined
        ? '<div class="sub">VRAM ' + F.bytes(g.vram_used) + " / " + F.bytes(g.vram_total) + "</div>" + bar(g.vram_percent)
        : "")));

  const t = n.temps || {};
  cards.push(card("Températures",
    '<div class="big">' + (t.apu !== undefined ? t.apu : "—") + '<small>°C APU</small></div>'
    + '<div class="sub">'
    + (t.ssd !== undefined ? "SSD " + t.ssd + " °C · " : "")
    + (t.batterie !== undefined ? "batterie " + t.batterie + " °C · " : "")
    + (t.boitier !== undefined ? "boîtier " + t.boitier + " °C" : "") + "</div>"
    + spark(h.apu, 100)
    + '<div class="sub">ventilateur ' + (n.fan === null || n.fan === undefined ? "—" : n.fan + " tr/min") + "</div>"));

  const b = n.battery || {};
  cards.push(card("Alimentation",
    '<div class="big">' + (b.capacity === null || b.capacity === undefined ? "—" : b.capacity) + '<small>%</small></div>'
    + '<div class="sub">' + (b.on_ac ? "sur secteur" : '<span class="offline">sur batterie</span>')
    + (b.status ? " · " + b.status.toLowerCase() : "")
    + (b.watts ? " · " + b.watts + " W" : "") + "</div>"
    + bar(b.capacity)));

  const disk = n.disk || {};
  cards.push(card("Stockage", Object.entries(disk).map(([k, v]) =>
    '<div class="big" style="font-size:20px">' + v.percent.toFixed(0) + '<small>% ' + k + '</small></div>'
    + '<div class="sub">' + F.bytes(v.free) + " libres sur " + F.bytes(v.total) + "</div>" + bar(v.percent)
  ).join('<div style="height:10px"></div>')));

  cards.push(card("Réseau",
    '<div class="big" style="font-size:20px">&#8595; ' + F.rate(n.net.rx) + "</div>"
    + '<div class="big" style="font-size:20px">&#8593; ' + F.rate(n.net.tx) + "</div>"
    + spark(h.rx)));

  const svc = Object.entries(d.services || {});
  if (svc.length) cards.push(card("Services", "<table><tbody>" + svc.map(([name, s]) =>
    "<tr><td><span class=\"dot " + (s.ok ? "ok" : "bad") + '"></span>' + name + "</td>"
    + '<td class="num">' + (s.code === null || s.code === undefined ? "injoignable" : s.code) + "</td>"
    + '<td class="num">' + (s.ms === null || s.ms === undefined ? "—" : s.ms + " ms") + "</td></tr>"
  ).join("") + "</tbody></table>"));

  if (d.containers && d.containers.length) cards.push('<div class="card wide"><h2>Conteneurs</h2>'
    + '<div class="scroll"><table><thead><tr><th>Nom</th><th class="num">Processeur</th>'
    + '<th class="num">Mémoire</th><th class="num">Part</th></tr></thead><tbody>'
    + d.containers.map(c => "<tr><td>" + c.name + '</td><td class="num">' + c.cpu
      + '</td><td class="num">' + c.memory + '</td><td class="num">' + c.mem_percent + "</td></tr>").join("")
    + "</tbody></table></div></div>");

  document.getElementById("grid").innerHTML = cards.join("");
}

async function tick() {
  try {
    const r = await fetch("api/metrics", { cache: "no-store" });
    render(await r.json());
  } catch (e) {
    document.getElementById("stamp").textContent = "hors ligne — nouvelle tentative…";
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
"""


def _allowed_origin(origin, host_header):
    """Autorise la lecture depuis l'interface Ashitaka, et rien d'autre.

    Ashitaka est servie sur le port 443 et ces relevés sur 8444 : pour le
    navigateur ce sont deux origines, il faut donc un en-tête explicite. On ne
    renvoie pas `*` pour autant — n'importe quel site visité par un navigateur
    présent sur le tailnet pourrait alors lire l'état de la machine. La règle
    est donc : même nom d'hôte que celui par lequel on nous appelle, quel que
    soit le port.
    """
    if not origin or not host_header:
        return None
    try:
        from urllib.parse import urlsplit

        asked = urlsplit(origin).hostname
    except Exception:
        return None
    ours = host_header.rsplit(":", 1)[0] if ":" in host_header else host_header
    ours = ours.strip("[]").lower()
    if asked and asked.lower() == ours:
        return origin
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "deck-monitor"

    def _send(self, code, body, content_type):
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        allowed = _allowed_origin(self.headers.get("Origin"), self.headers.get("Host"))
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif path == "/api/metrics":
            self._send(200, json.dumps(_payload()), "application/json; charset=utf-8")
        elif path == "/healthz":
            self._send(200, "ok", "text/plain; charset=utf-8")
        else:
            self._send(404, "introuvable", "text/plain; charset=utf-8")

    def log_message(self, *args):
        # Un relevé toutes les deux secondes saturerait le journal systemd.
        pass


def main():
    for target in (_fast_loop, _slow_loop):
        threading.Thread(target=target, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"DECK_MONITOR_READY http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
