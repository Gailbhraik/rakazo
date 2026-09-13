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
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta
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


# --- consommation Claude Code -----------------------------------------------
#
# Claude Code écrit une transcription par session dans `~/.claude/projects`,
# et chaque message d'assistant y porte son relevé `usage`. C'est la seule
# source locale : le pourcentage de quota d'abonnement, lui, vit chez
# Anthropic et n'est pas mis en cache sur la machine.
#
# Deux pièges, tous deux vérifiés sur les fichiers de ce Deck :
#
# 1. Une même requête apparaît sur plusieurs lignes — une par bloc de contenu,
#    numérotées par `apiBlockIndex` — et **toutes répètent le même `usage`**.
#    Sommer les lignes comptait ici 369 relevés pour 42 requêtes réelles, soit
#    presque trois fois la consommation. On déduplique donc par `requestId`.
# 2. Les horodatages sont en UTC. Regrouper par jour sans repasser en heure
#    locale rangerait une soirée d'été dans la journée précédente.

CLAUDE_HOME = os.path.expanduser(os.environ.get("CLAUDE_HOME", "~/.claude"))

# Les transcriptions du PC arrivent ici, recopiées par
# `infra/monitoring/sync-claude-pc.sh`. On ne les lit pas sur le PC lui-même :
# il est souvent éteint, alors que le Deck sert cette page en continu.
CLAUDE_SYNC_ROOT = os.path.expanduser(os.environ.get("CLAUDE_SYNC_ROOT", "~/.claude-sync"))

# Chaque machine et le répertoire où lire ses transcriptions. Le nom est celui
# que la page affiche ; l'ordre est celui des lignes du tableau par machine.
CLAUDE_SOURCES = (
    ("Deck", os.path.join(CLAUDE_HOME, "projects")),
    ("PC", os.path.join(CLAUDE_SYNC_ROOT, "pc", "projects")),
)


def _claude_machine(path):
    """Machine d'origine d'une transcription, d'après le répertoire qui la contient."""
    for name, root in CLAUDE_SOURCES:
        if path.startswith(root + os.sep):
            return name
    return "?"


def _claude_last_sync(name):
    """Dernière synchronisation d'une machine recopiée, ou None pour le Deck.

    Le script de synchronisation réécrit ce témoin à chaque passage, même sans
    fichier neuf : il date donc le dernier contact avec le PC, pas sa dernière
    session — ce qui distingue « PC éteint depuis trois jours » de « rien de neuf ».
    """
    if name == "Deck":
        return None
    marker = os.path.join(CLAUDE_SYNC_ROOT, name.lower(), ".last-sync")
    try:
        with open(marker) as fh:
            return fh.read().strip() or None
    except OSError:
        return None

# Tarifs de l'API, en dollars par million de tokens (entrée, sortie).
CLAUDE_PRICES = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5-1": (10.0, 50.0),
    "claude-mythos-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# Une écriture de cache coûte 1,25 × l'entrée en TTL cinq minutes mais 2 × en
# TTL une heure, et une lecture 0,1 ×. Les deux TTL restent séparés : les
# confondre gonflerait l'écriture de soixante pour cent, et Claude Code écrit
# précisément en TTL une heure.
CACHE_WRITE_5M = 1.25
CACHE_WRITE_1H = 2.0
CACHE_READ = 0.1

_claude_lock = threading.Lock()
_claude_files = {}  # chemin -> {mtime, size, offset, seen, rows}


def _claude_price(model):
    """Tarif du modèle, en tolérant un suffixe de date (`…-4-5-20251001`)."""
    if model in CLAUDE_PRICES:
        return CLAUDE_PRICES[model]
    best = None
    for known in CLAUDE_PRICES:
        if model and model.startswith(known) and (best is None or len(known) > len(best)):
            best = known
    return CLAUDE_PRICES[best] if best else None


def _claude_cost(row):
    """Coût équivalent au tarif API, ou None si le modèle est inconnu."""
    price = _claude_price(row["model"])
    if price is None:
        return None
    per_in, per_out = price
    return (
        row["input"] * per_in
        + row["output"] * per_out
        + row["write5m"] * per_in * CACHE_WRITE_5M
        + row["write1h"] * per_in * CACHE_WRITE_1H
        + row["read"] * per_in * CACHE_READ
    ) / 1e6


def _claude_parse(line, seen):
    """Un relevé par requête, ou None si la ligne n'en porte pas de nouveau."""
    try:
        entry = json.loads(line)
    except Exception:
        return None
    if entry.get("type") != "assistant":
        return None
    message = entry.get("message") or {}
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    # `requestId` identifie l'appel facturé ; les deux replis servent aux
    # transcriptions anciennes qui ne le portaient pas encore.
    key = entry.get("requestId") or message.get("id") or entry.get("uuid")
    if key is None or key in seen:
        return None
    seen.add(key)
    creation = usage.get("cache_creation") or {}
    write_5m = creation.get("ephemeral_5m_input_tokens")
    write_1h = creation.get("ephemeral_1h_input_tokens")
    unknown_ttl = 0
    if write_5m is None and write_1h is None:
        # Sans la ventilation par TTL on ne peut pas savoir laquelle des deux
        # a été payée. On retient le tarif cinq minutes, le moins cher, et on
        # remonte le volume concerné pour que la page puisse le dire.
        unknown_ttl = usage.get("cache_creation_input_tokens") or 0
        write_5m, write_1h = unknown_ttl, 0
    return {
        "ts": entry.get("timestamp"),
        "model": message.get("model"),
        "input": usage.get("input_tokens") or 0,
        "output": usage.get("output_tokens") or 0,
        "write5m": write_5m or 0,
        "write1h": write_1h or 0,
        "read": usage.get("cache_read_input_tokens") or 0,
        "unknown_ttl": unknown_ttl,
    }


def _claude_scan_file(path):
    """Relit ce qui s'est ajouté depuis le dernier passage, et rien de plus.

    La session en cours grossit en continu : relire le fichier entier à chaque
    affichage serait du gaspillage. On garde donc la position atteinte, et on
    s'arrête au dernier saut de ligne — la dernière ligne d'un fichier en cours
    d'écriture peut être tronquée.
    """
    try:
        stat = os.stat(path)
    except OSError:
        _claude_files.pop(path, None)
        return
    state = _claude_files.get(path)
    if state is None or stat.st_size < state["size"]:
        # Fichier neuf, ou réécrit plus court que ce qu'on avait lu : on repart
        # du début plutôt que de reprendre à une position qui n'a plus de sens.
        state = {"size": 0, "offset": 0, "seen": set(), "rows": []}
        _claude_files[path] = state
    elif stat.st_size == state["size"] and stat.st_mtime == state["mtime"]:
        return
    state["mtime"] = stat.st_mtime
    state["size"] = stat.st_size
    try:
        with open(path, "rb") as fh:
            fh.seek(state["offset"])
            chunk = fh.read()
    except OSError:
        return
    cut = chunk.rfind(b"\n")
    if cut < 0:
        return
    state["offset"] += cut + 1
    for raw in chunk[:cut].split(b"\n"):
        if not raw.strip():
            continue
        row = _claude_parse(raw.decode("utf-8", "replace"), state["seen"])
        if row is not None:
            state["rows"].append(row)


def _claude_rows():
    """Toutes les requêtes relevées, par session, toutes machines confondues."""
    sessions = {}
    with _claude_lock:
        present = set()
        for _, root in CLAUDE_SOURCES:
            # Un répertoire absent — le PC jamais synchronisé — ne produit
            # simplement aucune session : `os.walk` n'y lève pas d'erreur.
            for dirpath, _, names in os.walk(root):
                for name in names:
                    if name.endswith(".jsonl"):
                        path = os.path.join(dirpath, name)
                        present.add(path)
                        _claude_scan_file(path)
        for stale in set(_claude_files) - present:
            del _claude_files[stale]
        for path, state in _claude_files.items():
            sessions[path] = list(state["rows"])
    return sessions


def _claude_bucket(rows):
    """Cumule un lot de requêtes en un poste affichable."""
    bucket = {
        "requests": 0,
        "input": 0,
        "output": 0,
        "write5m": 0,
        "write1h": 0,
        "read": 0,
        "cost": 0.0,
        "priced": 0,
    }
    for row in rows:
        bucket["requests"] += 1
        for field in ("input", "output", "write5m", "write1h", "read"):
            bucket[field] += row[field]
        cost = _claude_cost(row)
        if cost is not None:
            bucket["cost"] += cost
            bucket["priced"] += 1
    bucket["tokens"] = (
        bucket["input"] + bucket["output"] + bucket["write5m"] + bucket["write1h"] + bucket["read"]
    )
    return bucket


def _claude_day(row):
    """Journée locale de la requête — les horodatages sont en UTC."""
    if not row["ts"]:
        return None
    try:
        return datetime.fromisoformat(row["ts"]).astimezone().date().isoformat()
    except ValueError:
        return None


def _claude_payload():
    sessions = _claude_rows()
    everything = [row for rows in sessions.values() for row in rows]
    if not everything:
        return {
            "ready": False,
            "home": CLAUDE_HOME,
        }

    today_date = datetime.now().astimezone().date()
    today = today_date.isoformat()
    by_day = {}
    for row in everything:
        day = _claude_day(row)
        if day:
            by_day.setdefault(day, []).append(row)
    days = sorted(by_day)
    recent_days = days[-30:]
    # Sept jours du calendrier, aujourd'hui compris. Les sept derniers jours
    # *actifs* — ce que retenait `days[-7:]` — couvraient trois semaines dès que
    # l'usage s'espaçait, sous une tuile qui annonce « sept derniers jours ».
    week = {(today_date - timedelta(days=n)).isoformat() for n in range(7)}

    by_machine = {}
    session_count = {}
    for path, rows in sessions.items():
        machine = _claude_machine(path)
        by_machine.setdefault(machine, []).extend(rows)
        if rows:
            session_count[machine] = session_count.get(machine, 0) + 1
    machines = [
        {
            "machine": name,
            "sessions": session_count.get(name, 0),
            "lastSync": _claude_last_sync(name),
            "today": _claude_bucket([r for r in by_machine.get(name, []) if _claude_day(r) == today]),
            "week": _claude_bucket([r for r in by_machine.get(name, []) if _claude_day(r) in week]),
            "all": _claude_bucket(by_machine.get(name, [])),
        }
        for name, _ in CLAUDE_SOURCES
    ]

    by_model = {}
    for row in everything:
        by_model.setdefault(row["model"] or "inconnu", []).append(row)

    session_rows = []
    for path, rows in sessions.items():
        if not rows:
            continue
        stamps = sorted(r["ts"] for r in rows if r["ts"])
        bucket = _claude_bucket(rows)
        session_rows.append(
            {
                # Ni titre ni texte : la page est servie sur le tailnet, et le
                # sujet d'une conversation n'a pas à y transiter. Le répertoire
                # de travail suffit à reconnaître une session.
                "machine": _claude_machine(path),
                "project": os.path.basename(os.path.dirname(path)),
                "session": os.path.basename(path)[:-6][:8],
                "first": stamps[0] if stamps else None,
                "last": stamps[-1] if stamps else None,
                "requests": bucket["requests"],
                "tokens": bucket["tokens"],
                "cost": bucket["cost"],
            }
        )
    session_rows.sort(key=lambda s: s["last"] or "", reverse=True)

    return {
        "ready": True,
        "home": CLAUDE_HOME,
        "sessions": len(session_rows),
        "machines": machines,
        "today": _claude_bucket(by_day.get(today, [])),
        "week": _claude_bucket([r for r in everything if _claude_day(r) in week]),
        "all": _claude_bucket(everything),
        "days": [
            {"day": day, **_claude_bucket(by_day[day])}
            for day in recent_days
        ],
        "models": sorted(
            (
                {"model": model, **_claude_bucket(rows)}
                for model, rows in by_model.items()
            ),
            key=lambda m: -m["cost"],
        ),
        "recentSessions": session_rows[:12],
        "unpriced": sorted(
            {
                row["model"] or "inconnu"
                for row in everything
                if _claude_price(row["model"]) is None
            }
        ),
        "unknownTtlTokens": sum(row["unknown_ttl"] for row in everything),
        "host": os.uname().nodename,
    }


# --- service HTTP -----------------------------------------------------------

# Palette et primitives partagées par les deux pages du service. Une seule
# définition : deux copies dériveraient à la première retouche.
CSS = r"""
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
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Quatre colonnes ne tiennent pas sur un écran de téléphone : le tableau
     défile dans son propre cadre plutôt que d'élargir la page. */
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .scroll table { min-width: 420px; }
  tr:last-child td { border-bottom: 0; }
  .wide { grid-column: 1 / -1; }
  .note {
    border: 1px solid var(--line); border-left: 3px solid var(--muted);
    background: #14141a; border-radius: 8px; padding: 9px 12px;
    font-size: 12.5px; color: var(--muted); margin-top: 14px;
  }
  .note a { color: var(--ink); }
"""

PAGE = (
    r"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Steam Deck — supervision</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>"""
    + CSS
    + r"""
  .alerts { display: grid; gap: 8px; margin-bottom: 14px; }
  .alert {
    border: 1px solid var(--line); border-left: 3px solid var(--warn);
    background: #1c1a14; border-radius: 8px; padding: 9px 12px; font-size: 13px;
  }
  .alert.bad { border-left-color: var(--bad); background: #1e1415; }
  svg.spark { display: block; width: 100%; height: 34px; margin-top: 8px; }
  .cores { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; margin-top: 9px; }
  .cores > i { display: block; height: 26px; background: #26262c; border-radius: 2px; position: relative; }
  .cores > i > b { position: absolute; bottom: 0; left: 0; right: 0; background: var(--accent); border-radius: 2px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
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
)

CLAUDE_PAGE = (
    r"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Consommation Claude</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>"""
    + CSS
    + r"""
  .days { display: grid; gap: 6px; margin-top: 4px; }
  .live { color: var(--muted); font-size: 12px; }
  .stale { color: var(--bad); font-size: 12px; }
  .muted { color: var(--muted); font-size: 12px; }
  .machines { display: grid; gap: 12px; }
  .machine + .machine { border-top: 1px solid var(--line); padding-top: 12px; }
  .machine .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .machine .figures { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 8px 0 4px; }
  .machine .figures span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .machine .figures b { display: block; font-size: 14px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .day { display: grid; grid-template-columns: 4.6em 1fr 4.6em; align-items: center; gap: 9px; font-size: 12.5px; }
  .day > span { color: var(--muted); font-variant-numeric: tabular-nums; }
  .day > span.cost { text-align: right; color: var(--ink); }
  .day > i { display: block; height: 8px; background: #26262c; border-radius: 2px; overflow: hidden; }
  .day > i > b { display: block; height: 100%; background: var(--accent); }
  .day.now > span { color: var(--ink); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin-top: 10px; font-size: 12.5px; }
  .split > span { color: var(--muted); }
  .split > b { font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Consommation Claude</h1>
  <span class="host" id="host"></span>
  <span class="stamp" id="stamp">lecture…</span>
</header>
<div id="out"></div>
<div class="note">
  Relevés calculés depuis les transcriptions de Claude Code, dédupliquées par
  requête : celles de ce Deck (<code id="home"></code>), y compris la session
  pilotée depuis le téléphone, et celles du PC, recopiées à chaque
  synchronisation — les chiffres du PC ne sont donc à jour qu'à la date indiquée.
  Deux limites : <b>les conversations de l'application Claude ou de claude.ai ne
  sont pas comptées</b>, faute de transcription locale, et les montants sont un
  <b>équivalent au tarif de l'API</b>, pas une facture : un abonnement ne
  facture pas au token. Pour le quota réel :
  <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">claude.ai/settings/usage</a>.
</div>
<script>
const F = {
  money(v) {
    if (v === null || v === undefined) return "—";
    if (v > 0 && v < 0.01) return "< 0,01 $";
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" }).format(v);
  },
  tokens(n) {
    if (!n) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(".", ",") + " M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + " k";
    return String(n);
  },
  int(n) { return new Intl.NumberFormat("fr-FR").format(n || 0); },
  day(iso) {
    const [y, m, d] = iso.split("-");
    return d + "/" + m;
  },
  clock(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  },
  when(iso) {
    if (!iso) return "—";
    const at = new Date(iso);
    const today = new Date().toDateString() === at.toDateString();
    return today ? F.clock(iso) : at.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  },
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function tile(title, bucket, extra) {
  return '<div class="card"><h2>' + title + "</h2>"
    + '<div class="big">' + F.money(bucket.cost) + "</div>"
    + '<div class="sub">' + F.tokens(bucket.tokens) + " tokens · "
    + F.int(bucket.requests) + " req.</div>"
    + (extra || "") + "</div>";
}

function render(d) {
  document.getElementById("host").textContent = d.host || "";
  document.getElementById("home").textContent = d.home || "";
  document.getElementById("stamp").textContent =
    "à " + new Date().toLocaleTimeString("fr-FR");
  const out = document.getElementById("out");

  if (!d.ready) {
    out.innerHTML = '<div class="card"><p class="empty">Aucune transcription de '
      + "Claude Code sur cette machine pour l'instant. Une session enregistre son "
      + "relevé au premier échange.</p></div>";
    return;
  }

  const parts = [];

  // Les quatre postes de la journée : l'écriture de cache et la lecture pèsent
  // souvent plus que la sortie, ce que le seul total masquerait.
  const t = d.today;
  const split = '<div class="split">'
    + "<span>entrée</span><b>" + F.tokens(t.input) + "</b>"
    + "<span>sortie</span><b>" + F.tokens(t.output) + "</b>"
    + "<span>cache écrit</span><b>" + F.tokens(t.write5m + t.write1h) + "</b>"
    + "<span>cache lu</span><b>" + F.tokens(t.read) + "</b>"
    + "</div>";

  parts.push('<div class="grid">'
    + tile("Aujourd'hui", d.today, split)
    + tile("Sept derniers jours", d.week)
    + tile("Depuis le début", d.all,
        '<div class="sub">' + F.int(d.sessions) + " session"
        + (d.sessions > 1 ? "s" : "") + "</div>")
    + "</div>");

  // Répartition par machine. L'état dit d'où vient la fraîcheur du chiffre :
  // le Deck est lu en direct, le PC seulement à sa dernière synchronisation —
  // un PC éteint depuis trois jours afficherait sinon un total figé sans le dire.
  if (d.machines && d.machines.length) {
    const state = (m) => {
      if (m.machine === "Deck") return '<span class="live">en direct</span>';
      if (!m.lastSync) return '<span class="stale">jamais synchronisé</span>';
      const minutes = Math.round((Date.now() - new Date(m.lastSync).getTime()) / 60000);
      const ago = minutes < 1 ? "à l'instant"
        : minutes < 60 ? "il y a " + minutes + " min"
        : minutes < 1440 ? "il y a " + Math.round(minutes / 60) + " h"
        : "il y a " + Math.round(minutes / 1440) + " j";
      return '<span class="' + (minutes > 1440 ? "stale" : "live") + '">synchronisé ' + ago + "</span>";
    };
    // Un bloc par machine plutôt qu'un tableau : quatre colonnes ne tiennent pas
    // sur un téléphone, et le total finissait caché derrière un défilement.
    const blocks = d.machines.map((m) =>
      '<div class="machine"><div class="head"><b>' + esc(m.machine) + "</b>"
      + state(m) + "</div>"
      + '<div class="figures">'
      + "<div><span>Aujourd'hui</span><b>" + F.money(m.today.cost) + "</b></div>"
      + "<div><span>7 jours</span><b>" + F.money(m.week.cost) + "</b></div>"
      + "<div><span>Total</span><b>" + F.money(m.all.cost) + "</b></div>"
      + '</div><div class="muted">' + F.int(m.sessions) + " session"
      + (m.sessions > 1 ? "s" : "") + "</div></div>").join("");
    parts.push('<div class="grid" style="margin-top:12px"><div class="card wide">'
      + '<h2>Par machine</h2><div class="machines">' + blocks + "</div></div></div>");
  }

  if (d.days.length > 1) {
    const top = Math.max(...d.days.map((x) => x.cost)) || 1;
    const today = new Date().toISOString().slice(0, 10);
    const rows = d.days.slice(-14).map((x) =>
      '<div class="day' + (x.day === today ? " now" : "") + '">'
      + "<span>" + F.day(x.day) + "</span>"
      + '<i><b style="width:' + ((x.cost / top) * 100).toFixed(1) + '%"></b></i>'
      + '<span class="cost">' + F.money(x.cost) + "</span></div>").join("");
    parts.push('<div class="grid" style="margin-top:12px"><div class="card wide">'
      + "<h2>Par jour</h2><div class=\"days\">" + rows + "</div></div></div>");
  }

  const models = d.models.map((m) =>
    "<tr><td>" + esc(m.model) + '</td><td class="num">' + F.int(m.requests)
    + '</td><td class="num">' + F.tokens(m.output)
    + '</td><td class="num">' + F.tokens(m.write5m + m.write1h)
    + '</td><td class="num">' + F.tokens(m.read)
    + '</td><td class="num">' + F.money(m.cost) + "</td></tr>").join("");
  parts.push('<div class="grid" style="margin-top:12px"><div class="card wide">'
    + '<h2>Par modèle</h2><div class="scroll"><table><thead><tr><th>Modèle</th>'
    + '<th class="num">Req.</th><th class="num">Sortie</th>'
    + '<th class="num">Cache écrit</th><th class="num">Cache lu</th>'
    + '<th class="num">Équiv. API</th></tr></thead><tbody>'
    + models + "</tbody></table></div></div></div>");

  const sessions = d.recentSessions.map((s) =>
    "<tr><td>" + esc(s.machine) + "</td><td>" + esc(s.project) + "</td><td>" + esc(s.session)
    + "</td><td>" + F.when(s.first) + " → " + F.when(s.last)
    + '</td><td class="num">' + F.int(s.requests)
    + '</td><td class="num">' + F.tokens(s.tokens)
    + '</td><td class="num">' + F.money(s.cost) + "</td></tr>").join("");
  parts.push('<div class="grid" style="margin-top:12px"><div class="card wide">'
    + '<h2>Sessions récentes</h2><div class="scroll"><table><thead><tr>'
    + "<th>Machine</th><th>Projet</th><th>Session</th><th>Plage</th>"
    + '<th class="num">Req.</th><th class="num">Tokens</th>'
    + '<th class="num">Équiv. API</th></tr></thead><tbody>'
    + sessions + "</tbody></table></div></div></div>");

  if (d.unpriced.length) {
    parts.push('<div class="note">Modèles sans tarif connu, exclus des montants : '
      + d.unpriced.map(esc).join(", ") + ".</div>");
  }
  if (d.unknownTtlTokens) {
    parts.push('<div class="note">' + F.tokens(d.unknownTtlTokens)
      + " tokens d'écriture de cache sans ventilation par durée : comptés au "
      + "tarif cinq minutes, le moins cher des deux.</div>");
  }

  out.innerHTML = parts.join("");
}

async function tick() {
  try {
    // Chemin absolu : la page répond aussi sur « /claude/ », dont la barre
    // finale ferait résoudre un chemin relatif vers « /claude/api/claude ».
    const res = await fetch("/api/claude", { cache: "no-store" });
    render(await res.json());
  } catch (err) {
    document.getElementById("stamp").textContent = "injoignable";
  }
}
tick();
// Une transcription ne bouge qu'au rythme des échanges : dix secondes suffisent.
setInterval(tick, 10000);
</script>
</body>
</html>
"""
)


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


# --- portefeuille -------------------------------------------------------------
#
# Une liste de positions saisies à la main, servie sur `/portfolio` et gardée
# dans un fichier du Deck via `/api/portfolio`. Dans le seul navigateur, Safari
# l'effacerait après sept jours sans visite, et chaque appareil aurait sa copie.
#
# Écriture protégée à quatre niveaux :
# - PUT avec `Content-Type: application/json` n'est pas une requête « simple » :
#   un autre site doit obtenir l'accord d'une requête OPTIONS préalable, et ce
#   service n'y répond pas. Le navigateur bloque donc l'écriture avant l'envoi ;
# - l'en-tête `Origin`, quand il est présent, doit désigner ce même hôte ;
# - `baseEditedAt` désigne la version sur laquelle la modification a été faite :
#   si le Deck en détient une autre, l'écriture est refusée (409) et la page
#   rejoue sa modification sur l'état frais. Sans cela, une suppression faite
#   depuis une liste chargée avant un ajout ailleurs effacerait cet ajout ;
# - sans `baseEditedAt`, une écriture plus ancienne que l'état détenu est refusée.

PORTFOLIO_PAGE = (
    r"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Portefeuille</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>"""
    + CSS
    + r"""
  .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
  .summary .card { padding: 10px 11px; }
  .summary .big { font-size: 17px; overflow-wrap: anywhere; }
  .up { color: var(--ok); } .down { color: var(--bad); }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; font-size: 12.5px; color: var(--muted); }
  button {
    font: inherit; font-size: 14px; border-radius: 10px; padding: 10px 14px;
    border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .5; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 6px 11px; font-size: 13px; background: transparent; color: var(--muted); }
  .seg button.on { background: var(--line); color: var(--ink); }
  .status { color: var(--muted); font-size: 12.5px; margin-left: auto; }
  .status.err { color: var(--bad); }
  .list { display: grid; gap: 8px; }
  .pos {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; width: 100%;
    text-align: left; padding: 11px 13px; border-radius: 12px;
  }
  .pos .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pos .sym { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 5px; }
  .pos .value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pos .detail, .pos .pl { font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .pos .detail { color: var(--muted); }
  .pos .pl { text-align: right; }
  .pos .src { grid-column: 1 / -1; font-size: 11.5px; color: var(--muted); }
  .pos .src.err { color: var(--warn); }
  .empty { color: var(--muted); text-align: center; padding: 28px 10px; }
  form { display: grid; gap: 10px; }
  label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
  input {
    font: inherit; font-size: 16px; color: var(--ink); background: var(--bg);
    border: 1px solid var(--line); border-radius: 9px; padding: 10px 11px; width: 100%;
  }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions .spacer { flex: 1; }
</style>
</head>
<body>
<header><h1>Portefeuille</h1></header>

<div class="summary">
  <div class="card"><h2>Valeur</h2><div class="big" id="sValue">—</div><div class="sub" id="sDay"></div></div>
  <div class="card"><h2>Investi</h2><div class="big" id="sInvested">—</div></div>
  <div class="card"><h2>Plus-value</h2><div class="big" id="sPl">—</div><div class="sub" id="sPct"></div></div>
</div>

<div class="toolbar">
  <button class="primary" id="addBtn" type="button">Ajouter une position</button>
  <button id="refreshBtn" type="button">Actualiser</button>
  <span class="status" id="status">chargement…</span>
</div>
<div class="meta">
  Afficher en
  <span class="seg"><button type="button" id="curEUR">€</button><button type="button" id="curUSD">$</button></span>
  <span id="quoteInfo"></span>
</div>

<div class="card" id="formCard" hidden style="margin-bottom:12px">
  <form id="form" autocomplete="off">
    <div class="row2">
      <label>Symbole Nasdaq<input id="fSymbol" required maxlength="15" placeholder="AAPL" autocapitalize="characters"></label>
      <label>Nom<input id="fName" maxlength="40" placeholder="facultatif"></label>
    </div>
    <div class="row2">
      <label>Quantité<input id="fQty" inputmode="decimal" required placeholder="10"></label>
      <label id="lPru">Prix d'achat ($)<input id="fPru" inputmode="decimal" required placeholder="180,00"></label>
    </div>
    <div class="actions">
      <button class="primary" type="submit">Enregistrer</button>
      <button type="button" id="cancelBtn">Annuler</button>
      <span class="spacer"></span>
      <button type="button" class="danger" id="deleteBtn" hidden>Supprimer</button>
    </div>
  </form>
</div>

<div class="list" id="list"></div>

<script>
"use strict";
const API = "/api/portfolio";
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
let positions = [];
// Tout est ENREGISTRÉ en dollars — prix d'achat comme cours, ceux du Nasdaq.
// `currency` n'est qu'un choix d'AFFICHAGE : en euros, `conv` convertit au taux du
// jour, et c'est la seule conversion de la page. Une version précédente faisait de
// ce réglage la devise de saisie et convertissait les cours sans les prix d'achat :
// saisis en dollars, ceux-ci passaient pour des euros.
let currency = "EUR";         // devise d'affichage, commune à tous les appareils
let live = {};                // symbole -> cours en dollars, en mémoire seulement
let usdEur = null;            // taux BCE du dernier rafraîchissement
let rateDate = null;
let quoteError = "";
let editing = null;           // id de la position ouverte, ou "new"
let busy = false;

const $ = (id) => document.getElementById(id);
const qtyFmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 6 });
// Sans taux connu, l'affichage reste en dollars plutôt que de mélanger deux devises.
const shown = () => (currency === "EUR" && usdEur ? "EUR" : "USD");
const conv = (usd) => (shown() === "EUR" ? usd * usdEur : usd);
const money = (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: shown() }).format(v);
const signed = (v) => (v > 0 ? "+" : "") + money(v);
const pct = (v, digits) => (v > 0 ? "+" : "") + v.toFixed(digits).replace(".", ",") + " %";

// Saisie à la française : « 12,5 » comme « 12.5 », espaces de milliers tolérés.
function parseNum(s) {
  const t = String(s == null ? "" : s).trim().replace(/[\s  ]/g, "").replace(",", ".");
  return t === "" ? NaN : Number(t);
}

// Le cours n'est plus saisi : il vient de Finnhub. Un ancien champ `price`
// éventuellement enregistré est simplement ignoré.
function normalize(p) {
  if (!p || typeof p !== "object") return null;
  const raw = String(p.symbol || "").trim().toUpperCase();
  const symbol = SYMBOL_RE.test(raw) ? raw : "";
  const name = String(p.name || p.ticker || symbol).trim().slice(0, 40);
  const qty = Number(p.qty), pru = Number(p.pru);
  if (!name || !(qty > 0) || !(pru >= 0)) return null;
  return { id: String(p.id || crypto.randomUUID()), name, symbol, qty, pru };
}

function say(text, isErr) {
  $("status").textContent = text;
  $("status").className = "status" + (isErr ? " err" : "");
}

async function fetchState() {
  const r = await fetch(API, { cache: "no-store" });
  if (r.status === 404) return { positions: [], currency: "EUR", editedAt: 0 };
  if (!r.ok) throw new Error("lecture refusée (" + r.status + ")");
  const d = await r.json();
  return {
    positions: (Array.isArray(d.positions) ? d.positions : []).map(normalize).filter(Boolean),
    currency: d.currency === "USD" ? "USD" : "EUR",
    editedAt: Number(d.editedAt) || 0,
  };
}

// Chaque modification est rejouée sur l'état FRAIS du Deck, jamais sur la liste
// affichée : un ajout fait sur un autre appareil depuis le chargement de la page
// survit ainsi à une suppression faite ici. Si le Deck change encore entre la
// lecture et l'écriture, il répond 409 et l'on recommence.
async function commit(change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await fetchState();
    const next = change({ positions: fresh.positions.slice(), currency: fresh.currency });
    const body = {
      v: 1,
      positions: next.positions,
      currency: next.currency,
      // Toujours après la version lue, même si l'horloge de cet appareil
      // retarde sur celle de l'appareil qui a écrit en dernier.
      editedAt: Math.max(Date.now(), fresh.editedAt + 1),
      baseEditedAt: fresh.editedAt,
    };
    const r = await fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { positions = next.positions; currency = next.currency; return; }
    if (r.status !== 409) throw new Error("écriture refusée (" + r.status + ")");
  }
  throw new Error("le portefeuille change trop vite ailleurs, réessaie");
}

// Les cours ne sont jamais enregistrés : récupérés à la demande en dollars, avec
// le taux du jour, gardés en mémoire et affichés avec leur heure.
async function refreshQuotes() {
  const symbols = [...new Set(positions.map((p) => p.symbol).filter(Boolean))];
  if (!symbols.length) { live = {}; quoteError = ""; render(); return; }
  try {
    const r = await fetch("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")), { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "cours indisponibles (" + r.status + ")");
    live = d.quotes || {};
    if (d.rate) { usdEur = d.rate; rateDate = d.rateDate; }
    quoteError = "";
  } catch (e) {
    quoteError = e.message;
  }
  render();
}

// Un cours est « en direct » s'il date de moins de 20 minutes ; au-delà, c'est
// la clôture d'une séance passée — marché fermé, week-end.
function quoteLabel(q) {
  if (!q || q.error) return null;
  const at = new Date(q.t * 1000);
  if (Date.now() - at.getTime() < 20 * 60 * 1000) {
    return "en direct · " + at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
  return "clôture du " + at.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

// Sans cours disponible, la ligne est valorisée à son prix d'achat — plus-value
// nulle — et le dit, plutôt que de disparaître des totaux sans explication.
// Renvoie des montants DÉJÀ convertis dans la devise affichée.
function effective(p) {
  const q = p.symbol ? live[p.symbol] : null;
  const pru = conv(p.pru);
  if (q && !q.error && q.price > 0) {
    return { price: conv(q.price), prev: q.prevClose ? conv(q.prevClose) : null, pru, q, ok: true };
  }
  return { price: pru, prev: null, pru, q, ok: false };
}

function render() {
  $("curEUR").className = currency === "EUR" ? "on" : "";
  $("curUSD").className = currency === "USD" ? "on" : "";

  let value = 0, invested = 0, day = 0, dayKnown = false;
  for (const p of positions) {
    const e = effective(p);
    value += p.qty * e.price;
    invested += p.qty * e.pru;
    if (e.prev) { day += p.qty * (e.price - e.prev); dayKnown = true; }
  }
  const pl = value - invested;
  $("sValue").textContent = money(value);
  $("sDay").textContent = dayKnown ? "jour " + signed(day) : "";
  $("sDay").className = "sub " + (day > 0 ? "up" : day < 0 ? "down" : "");
  $("sInvested").textContent = money(invested);
  $("sPl").textContent = signed(pl);
  $("sPl").className = "big " + (pl > 0 ? "up" : pl < 0 ? "down" : "");
  $("sPct").textContent = invested > 0 ? pct((pl / invested) * 100, 2) : "";

  let info = "";
  if (quoteError) info = "Cours : " + quoteError;
  else if (currency === "EUR" && usdEur) {
    info = "1 $ = " + usdEur.toFixed(4).replace(".", ",") + " € (BCE, " + rateDate + ")";
  } else if (currency === "EUR" && !usdEur && positions.length) {
    info = "taux de change en attente — montants en dollars";
  }
  $("quoteInfo").textContent = info;
  $("quoteInfo").style.color = quoteError ? "var(--warn)" : "";

  const list = $("list");
  list.replaceChildren();
  if (!positions.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Aucune position. Ajoute ta première ligne.";
    list.append(empty);
    return;
  }
  const rows = positions.map((p) => ({ p, e: effective(p) }))
    .sort((a, b) => b.p.qty * b.e.price - a.p.qty * a.e.price);
  for (const { p, e } of rows) {
    const v = p.qty * e.price, cost = p.qty * e.pru, diff = v - cost;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pos card";
    // textContent partout : un nom saisi n'est jamais interprété comme du HTML.
    const cell = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    const name = cell("name", p.name);
    if (p.symbol) name.append(cell("sym", p.symbol));
    let src, srcErr = false;
    if (!p.symbol) { src = "sans symbole — valorisée au prix d'achat"; srcErr = true; }
    else if (e.q && e.q.error) { src = p.symbol + " : " + e.q.error + " — valorisée au prix d'achat"; srcErr = true; }
    else if (e.ok) src = quoteLabel(e.q) + (e.q.changePct != null ? " · jour " + pct(e.q.changePct, 2) : "");
    else src = "cours en attente…";
    btn.append(
      name,
      cell("value", money(v)),
      cell("detail", qtyFmt.format(p.qty) + " × " + money(e.price) + " · achat " + money(e.pru)),
      cell("pl " + (diff > 0 ? "up" : diff < 0 ? "down" : ""),
           signed(diff) + (cost > 0 ? " (" + pct((diff / cost) * 100, 1) + ")" : "")),
      cell("src" + (srcErr ? " err" : ""), src),
    );
    btn.addEventListener("click", () => openForm(p));
    list.append(btn);
  }
}

function openForm(p) {
  editing = p ? p.id : "new";
  $("fName").value = p ? p.name : "";
  $("fSymbol").value = p ? p.symbol : "";
  $("fQty").value = p ? String(p.qty).replace(".", ",") : "";
  $("fPru").value = p ? String(p.pru).replace(".", ",") : "";
  $("deleteBtn").hidden = !p;
  $("deleteBtn").textContent = "Supprimer";
  $("deleteBtn").dataset.armed = "";
  $("formCard").hidden = false;
  $("fSymbol").focus();
}

function closeForm() {
  editing = null;
  $("formCard").hidden = true;
}

async function run(label, change) {
  if (busy) return false;
  busy = true;
  say(label + "…");
  try {
    await commit(change);
    closeForm();
    render();
    say("Enregistré sur le Deck");
    return true;
  } catch (e) {
    say(e.message, true);
    return false;
  } finally {
    busy = false;
  }
}

$("addBtn").addEventListener("click", () => openForm(null));
$("cancelBtn").addEventListener("click", closeForm);
$("refreshBtn").addEventListener("click", async () => {
  say("Actualisation…");
  await refreshQuotes();
  say(quoteError ? "" : "Cours actualisés");
});

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const symbol = $("fSymbol").value.trim().toUpperCase();
  const name = $("fName").value.trim() || symbol;
  const qty = parseNum($("fQty").value);
  const pru = parseNum($("fPru").value);
  if (!SYMBOL_RE.test(symbol)) return say("Symbole invalide (ex. AAPL).", true);
  if (!(qty > 0)) return say("La quantité doit être positive.", true);
  if (!(pru >= 0)) return say("Le prix d'achat est invalide.", true);
  // Plus de cours de secours : on vérifie que Finnhub connaît le symbole AVANT
  // d'enregistrer, pour qu'une faute de frappe ne laisse pas une ligne sans cours.
  // Seul « symbole inconnu » bloque ; une panne passagère n'empêche pas la saisie.
  say("Vérification de " + symbol + "…");
  try {
    const r = await fetch("/api/quotes?currency=USD&symbols=" + encodeURIComponent(symbol), { cache: "no-store" });
    const d = await r.json();
    const q = d.quotes && d.quotes[symbol];
    if (q && q.error === "symbole inconnu") return say(symbol + " est inconnu de Finnhub — vérifie le symbole.", true);
  } catch (e) { /* Finnhub injoignable : on enregistre quand même */ }
  const id = editing === "new" ? crypto.randomUUID() : editing;
  const ok = await run("Enregistrement", (state) => {
    const i = state.positions.findIndex((x) => x.id === id);
    const item = { id, name, symbol, qty, pru };
    // Position supprimée ailleurs pendant l'édition : on la garde, puisque
    // l'intention exprimée ici est de la conserver.
    if (i < 0) state.positions.push(item); else state.positions[i] = item;
    return state;
  });
  if (ok) refreshQuotes();
});

// Suppression en deux temps : un premier appui arme le bouton, le second
// confirme. Plus sûr qu'un confirm(), que certains navigateurs bloquent dans
// une page incorporée.
$("deleteBtn").addEventListener("click", () => {
  const b = $("deleteBtn");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Confirmer la suppression"; return; }
  const id = editing;
  run("Suppression", (state) => { state.positions = state.positions.filter((x) => x.id !== id); return state; });
});

// Changer la devise d'affichage ne touche à aucun montant enregistré : tout reste
// en dollars, seule la conversion à l'écran change. Nul besoin de recoter.
async function setCurrency(c) {
  if (c === currency || busy) return;
  await run("Changement de devise", (state) => { state.currency = c; return state; });
}
$("curEUR").addEventListener("click", () => setCurrency("EUR"));
$("curUSD").addEventListener("click", () => setCurrency("USD"));

async function refresh() {
  if (busy || editing || document.hidden) return;
  try {
    const s = await fetchState();
    positions = s.positions; currency = s.currency;
    render();
    await refreshQuotes();
    say("À jour");
  } catch (e) {
    say(e.message, true);
  }
}

document.addEventListener("visibilitychange", refresh);
setInterval(refresh, 60000);
(async () => {
  try {
    const s = await fetchState();
    positions = s.positions; currency = s.currency;
    render();
    say(positions.length ? "À jour" : "");
    await refreshQuotes();
  } catch (e) {
    render();
    say(e.message, true);
  }
})();
</script>
</body>
</html>
"""
)

PORTFOLIO_DIR = os.path.expanduser(os.environ.get("ASHITAKA_DATA", "~/.local/share/ashitaka"))
PORTFOLIO_FILE = os.path.join(PORTFOLIO_DIR, "portfolio.json")
PORTFOLIO_MAX_BYTES = 2 * 1024 * 1024
_portfolio_lock = threading.Lock()


# --- cours des actions ----------------------------------------------------------
#
# Finnhub, avec la clé posée par l'utilisateur dans `~/.config/ashitaka/finnhub.key`.
# La clé ne quitte jamais le Deck : la page demande `/api/quotes`, et c'est ce
# service qui interroge Finnhub. Son offre gratuite ne cote que les actions
# américaines — vérifié le 13 septembre 2026 : AAPL, NVDA, MSFT répondent, et
# Paris, Amsterdam, Francfort renvoient 403.
#
# Les cours ne sont pas stockés : ce sont des données de marché, récupérées à la
# demande. Un cache court protège la limite gratuite (60 appels par minute)
# quand plusieurs appareils ont la page ouverte.

FINNHUB_KEY_FILE = os.path.expanduser("~/.config/ashitaka/finnhub.key")
QUOTE_TTL = 30          # secondes
FX_TTL = 3600           # le taux de la BCE ne change qu'une fois par jour ouvré
MAX_SYMBOLS = 25        # 25 appels par rafraîchissement, sous la limite de 60/min
_SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,14}$")
# Sans identifiant de navigateur, la BCE et Frankfurter répondent 403 à urllib.
_UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) deck-monitor"}
_quote_cache = {}
_fx_cache = {"at": 0.0, "rate": None, "date": None}
_quotes_lock = threading.Lock()


def _finnhub_key():
    try:
        with open(FINNHUB_KEY_FILE) as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _quote(symbol, key):
    """Cours d'un symbole, ou `{"error": …}`. Jamais la clé dans une erreur."""
    now = time.monotonic()
    hit = _quote_cache.get(symbol)
    if hit and now - hit[0] < QUOTE_TTL:
        return dict(hit[1])
    url = "https://finnhub.io/api/v1/quote?symbol=%s&token=%s" % (
        urllib.parse.quote(symbol), urllib.parse.quote(key))
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=10) as r:
            q = json.load(r)
    except urllib.error.HTTPError as exc:
        reason = {403: "place non couverte par la clé", 429: "limite Finnhub atteinte",
                  401: "clé Finnhub refusée"}.get(exc.code, "cours indisponible")
        return {"error": reason}
    except Exception:
        return {"error": "Finnhub injoignable"}
    # Finnhub ne renvoie pas d'erreur pour un symbole inconnu : tout à zéro.
    if not q.get("c") and not q.get("t"):
        result = {"error": "symbole inconnu"}
    else:
        result = {"price": q.get("c"), "prevClose": q.get("pc"),
                  "changePct": q.get("dp"), "t": q.get("t")}
    _quote_cache[symbol] = (now, result)
    return dict(result)


def _usd_to_eur():
    """Taux USD → EUR de la BCE, avec Frankfurter en secours. (taux, date) ou (None, None)."""
    now = time.monotonic()
    if _fx_cache["rate"] and now - _fx_cache["at"] < FX_TTL:
        return _fx_cache["rate"], _fx_cache["date"]
    rate = date = None
    try:
        req = urllib.request.Request("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", headers=_UA)
        with urllib.request.urlopen(req, timeout=10) as r:
            xml = r.read().decode("utf-8", "replace")
        usd = float(re.search(r"currency='USD' rate='([\d.]+)'", xml).group(1))
        rate, date = 1.0 / usd, re.search(r"time='([\d-]+)'", xml).group(1)
    except Exception:
        try:
            req = urllib.request.Request("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", headers=_UA)
            with urllib.request.urlopen(req, timeout=10) as r:
                d = json.load(r)
            rate, date = float(d["rates"]["EUR"]), d.get("date")
        except Exception:
            pass
    if rate:
        _fx_cache.update(at=now, rate=rate, date=date)
    return rate, date


def _quotes_payload(query):
    """Cours en DOLLARS, toujours, accompagnés du taux USD → EUR du jour.

    La conversion se fait côté page, en un seul endroit et avec ce seul taux,
    pour le cours comme pour le prix d'achat. Une version précédente convertissait
    ici le cours mais laissait la page afficher le prix d'achat tel quel : saisi en
    dollars, il passait pour des euros, et Adobe à +11 % s'affichait en perte.
    """
    params = urllib.parse.parse_qs(query)
    symbols = []
    for raw in ",".join(params.get("symbols") or []).split(","):
        sym = raw.strip().upper()
        if sym and _SYMBOL_RE.match(sym) and sym not in symbols:
            symbols.append(sym)
    symbols = symbols[:MAX_SYMBOLS]
    key = _finnhub_key()
    if not key:
        return 503, {"error": "clé Finnhub absente du Deck"}
    # Un taux indisponible n'empêche pas de coter : la page affichera en dollars
    # et le signalera.
    rate, date = _usd_to_eur()
    quotes = {}
    # Un seul rafraîchissement à la fois : deux appareils ouverts ensemble ne
    # doublent pas les appels, le second profite du cache du premier.
    with _quotes_lock:
        for sym in symbols:
            quotes[sym] = _quote(sym, key)
    return 200, {"currency": "USD", "rate": rate, "rateDate": date, "quotes": quotes}


def _portfolio_read():
    try:
        with open(PORTFOLIO_FILE, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None


def _portfolio_write(state):
    """Écriture atomique : un fichier temporaire, puis un renommage.

    Une coupure en pleine écriture laisse ainsi l'ancien portefeuille intact
    plutôt qu'un fichier tronqué. La version précédente est gardée à côté.
    """
    os.makedirs(PORTFOLIO_DIR, mode=0o700, exist_ok=True)
    os.chmod(PORTFOLIO_DIR, 0o700)
    tmp = PORTFOLIO_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    if os.path.exists(PORTFOLIO_FILE):
        shutil.copy2(PORTFOLIO_FILE, PORTFOLIO_FILE + ".prev")
    os.replace(tmp, PORTFOLIO_FILE)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "deck-monitor"

    def _send(self, code, body, content_type, headers=None):
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        allowed = _allowed_origin(self.headers.get("Origin"), self.headers.get("Host"))
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(payload)

    def _portfolio_json(self, code, obj):
        # L'en-tête permet à la page de reconnaître le Deck, y compris sur un
        # 404 : « aucun portefeuille ici » n'est pas « aucun service ici ».
        self._send(code, json.dumps(obj), "application/json; charset=utf-8",
                   {"X-Ashitaka-Portfolio": "1"})

    def _refuse(self, code, obj):
        """Refus prononcé AVANT d'avoir lu le corps de la requête.

        Ce corps resterait en attente sur la connexion. En HTTP/1.1 elle reste
        ouverte, et le proxy de Tailscale la réutilise : la requête suivante —
        celle d'un autre appareil, peut-être — serait lue à partir de ces octets
        et échouerait en 501. Constaté : trois écritures refusées, trois lectures
        légitimes perdues juste après. On ferme donc la connexion.
        """
        self.close_connection = True
        self._send(code, json.dumps(obj), "application/json; charset=utf-8",
                   {"X-Ashitaka-Portfolio": "1", "Connection": "close"})

    def do_PUT(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path != "/api/portfolio":
            self._refuse(404, {"error": "introuvable"})
            return
        origin = self.headers.get("Origin")
        if origin and not _allowed_origin(origin, self.headers.get("Host")):
            self._refuse(403, {"error": "origine refusée"})
            return
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            self._refuse(415, {"error": "JSON attendu"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            self._refuse(411, {"error": "longueur manquante"})
            return
        if length <= 0 or length > PORTFOLIO_MAX_BYTES:
            self._refuse(413, {"error": "taille refusée"})
            return
        try:
            state = json.loads(self.rfile.read(length))
        except ValueError:
            self._portfolio_json(400, {"error": "JSON invalide"})
            return
        if not isinstance(state, dict) or not isinstance(state.get("positions"), list):
            self._portfolio_json(400, {"error": "portefeuille invalide"})
            return
        # On arbitre sur `editedAt`, date de la dernière modification faite par
        # quelqu'un, et non sur `updatedAt`, que la page avance aussi en
        # actualisant un cours : un appareil simplement ouvert passait sinon pour
        # plus récent qu'un ajout fait ailleurs, et l'écrasait.
        incoming = state.get("editedAt")
        if not isinstance(incoming, (int, float)):
            self._portfolio_json(400, {"error": "editedAt manquant"})
            return
        base = state.pop("baseEditedAt", None)
        with _portfolio_lock:
            current = _portfolio_read()
            held = (current or {}).get("editedAt") or 0
            if base is not None:
                # La modification a été faite sur la version `base` : si le Deck
                # en détient une autre, elle ignorerait ce qui a changé depuis.
                if base != held:
                    self._portfolio_json(409, {"error": "le portefeuille a changé entre-temps", "editedAt": held})
                    return
            elif current and incoming < held:
                self._portfolio_json(409, {"error": "modification plus récente sur le Deck", "editedAt": held})
                return
            try:
                _portfolio_write(state)
            except OSError as exc:
                self._portfolio_json(500, {"error": "écriture impossible : %s" % exc.strerror})
                return
        self._portfolio_json(200, {"ok": True, "editedAt": incoming})

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif path == "/api/metrics":
            self._send(200, json.dumps(_payload()), "application/json; charset=utf-8")
        elif path == "/claude":
            self._send(200, CLAUDE_PAGE, "text/html; charset=utf-8")
        elif path == "/api/claude":
            self._send(200, json.dumps(_claude_payload()), "application/json; charset=utf-8")
        elif path == "/portfolio":
            self._send(200, PORTFOLIO_PAGE, "text/html; charset=utf-8")
        elif path == "/api/quotes":
            code, body = _quotes_payload(self.path.split("?", 1)[1] if "?" in self.path else "")
            self._send(code, json.dumps(body), "application/json; charset=utf-8")
        elif path == "/api/portfolio":
            state = _portfolio_read()
            if state is None:
                self._portfolio_json(404, {"exists": False})
            else:
                self._portfolio_json(200, state)
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
