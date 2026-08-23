#!/usr/bin/env python3
"""
LUQA PIXEL reference agent — minimal connectivity proof, not the real product yet.

Registers no state of its own: just heartbeats to LUQA's bench-heartbeat Edge
Function on an interval, so the bench shows up as "Online" in LUQA's Bench
list. The real hardware-driving logic (LED cabinet/poster QA sequence, ported
from the legacy tooling) lands in a later iteration of this repo — this file
exists purely to let a Raspberry Pi register its presence today.

Config comes from config.json (copy config.example.json) or environment
variables (LUQA_API_BASE, LUQA_BENCH_SLUG, LUQA_BENCH_TOKEN) — env vars win
if both are set.

Usage:
    pip3 install -r requirements.txt
    cp config.example.json config.json   # then fill in slug + token
    python3 agent.py
"""

import json
import os
import time
import sys
from pathlib import Path

import requests

CONFIG_PATH = Path(__file__).parent / "config.json"
HEARTBEAT_INTERVAL_S = 30
REQUEST_TIMEOUT_S = 10


def load_config() -> dict:
    config = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            config = json.load(f)

    config["api_base_url"] = os.environ.get("LUQA_API_BASE", config.get("api_base_url"))
    config["slug"] = os.environ.get("LUQA_BENCH_SLUG", config.get("slug"))
    config["token"] = os.environ.get("LUQA_BENCH_TOKEN", config.get("token"))

    missing = [k for k in ("api_base_url", "slug", "token") if not config.get(k)]
    if missing:
        print(f"Missing required config: {', '.join(missing)}", file=sys.stderr)
        print("Copy config.example.json to config.json and fill it in, or set LUQA_API_BASE / LUQA_BENCH_SLUG / LUQA_BENCH_TOKEN.", file=sys.stderr)
        sys.exit(1)
    return config


def read_cpu_temp_c() -> float | None:
    """Raspberry Pi-specific; returns None on any other platform (e.g. testing on a laptop)."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read().strip()) / 1000.0
    except (FileNotFoundError, ValueError):
        return None


def read_uptime_s() -> float | None:
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except (FileNotFoundError, ValueError):
        return None


def send_heartbeat(config: dict) -> None:
    diagnostics = {}
    cpu_temp = read_cpu_temp_c()
    if cpu_temp is not None:
        diagnostics["cpu_temp_c"] = cpu_temp
    uptime = read_uptime_s()
    if uptime is not None:
        diagnostics["uptime_s"] = uptime

    resp = requests.post(
        f"{config['api_base_url']}/functions/v1/bench-heartbeat",
        headers={"Content-Type": "application/json", "X-Bench-Token": config["token"]},
        json={"slug": config["slug"], "agent_version": "0.1.0-reference", "diagnostics": diagnostics},
        timeout=REQUEST_TIMEOUT_S,
    )
    if resp.ok:
        print(f"[heartbeat] ok — availability={resp.json().get('availability')}")
    else:
        print(f"[heartbeat] failed — HTTP {resp.status_code}: {resp.text}", file=sys.stderr)


def main() -> None:
    config = load_config()
    print(f"LUQA PIXEL reference agent starting — bench={config['slug']}, api={config['api_base_url']}")
    while True:
        try:
            send_heartbeat(config)
        except requests.RequestException as err:
            print(f"[heartbeat] network error: {err}", file=sys.stderr)
        time.sleep(HEARTBEAT_INTERVAL_S)


if __name__ == "__main__":
    main()
