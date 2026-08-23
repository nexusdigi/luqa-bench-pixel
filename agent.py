#!/usr/bin/env python3
"""
LUQA PIXEL reference agent — connectivity + job-dispatch proof, not the real
product yet.

Heartbeats to LUQA on an interval (bench shows up "Online"), and after each
heartbeat checks whether LUQA has a job reserved for it. If so: accepts it,
runs a FAKE placeholder test sequence (just sleeps and reports fabricated
progress/measurements — there is no real hardware wired up yet), then reports
completion. This proves the full session lifecycle end-to-end
(reserved -> running -> awaiting_confirmation) against a real device before
the actual LED-testing logic (ported from the legacy tooling) exists.

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
AGENT_VERSION = "0.1.0-reference"

# The FAKE test sequence this reference agent runs once it accepts a job —
# stands in for the real LED-test steps until the legacy tooling is ported.
FAKE_TEST_STEPS = ["precheck", "brightness", "resolution", "pattern_check"]


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


def call(config: dict, function_name: str, payload: dict) -> dict | None:
    resp = requests.post(
        f"{config['api_base_url']}/functions/v1/{function_name}",
        headers={"Content-Type": "application/json", "X-Bench-Token": config["token"]},
        json=payload,
        timeout=REQUEST_TIMEOUT_S,
    )
    if resp.ok:
        return resp.json()
    print(f"[{function_name}] failed — HTTP {resp.status_code}: {resp.text}", file=sys.stderr)
    return None


def send_heartbeat(config: dict) -> None:
    diagnostics = {}
    cpu_temp = read_cpu_temp_c()
    if cpu_temp is not None:
        diagnostics["cpu_temp_c"] = cpu_temp
    uptime = read_uptime_s()
    if uptime is not None:
        diagnostics["uptime_s"] = uptime

    result = call(config, "bench-heartbeat", {"slug": config["slug"], "agent_version": AGENT_VERSION, "diagnostics": diagnostics})
    if result is not None:
        print(f"[heartbeat] ok — availability={result.get('availability')}")


def poll_and_run_job(config: dict) -> None:
    poll = call(config, "bench-poll-job", {"slug": config["slug"]})
    if poll is None or not poll.get("job"):
        return

    job = poll["job"]
    session_id = job["session_id"]
    print(f"[job] found {job['session_code']} — accepting")

    respond = call(config, "bench-respond-job", {"slug": config["slug"], "session_id": session_id, "accept": True})
    if respond is None:
        return

    run_fake_test_sequence(config, session_id)


def run_fake_test_sequence(config: dict, session_id: str) -> None:
    """Placeholder sequence — proves the session lifecycle works end-to-end.
    Replace with the real LED-test steps once the hardware adapter is ported."""
    steps: dict[str, dict] = {}
    for step in FAKE_TEST_STEPS:
        steps[step] = {"status": "running"}
        call(config, "bench-report-progress", {"slug": config["slug"], "session_id": session_id, "progress": {"steps": steps}})
        print(f"[job] {session_id} — {step} running…")
        time.sleep(2)
        steps[step] = {"status": "done"}
        call(config, "bench-report-progress", {"slug": config["slug"], "session_id": session_id, "progress": {"steps": steps}})

    call(
        config,
        "bench-report-measurement",
        {
            "slug": config["slug"],
            "session_id": session_id,
            "measurements": [
                {"key": "fake_brightness", "label": "Brightness (fake)", "value": 100, "unit": "%", "lower_limit": 90, "upper_limit": 100, "pass": True},
            ],
        },
    )
    result = call(config, "bench-complete-session", {"slug": config["slug"], "session_id": session_id, "result": "pass"})
    if result is not None:
        print(f"[job] {session_id} — done, status={result.get('status')}")


def main() -> None:
    config = load_config()
    print(f"LUQA PIXEL reference agent starting — bench={config['slug']}, api={config['api_base_url']}")
    while True:
        try:
            send_heartbeat(config)
            poll_and_run_job(config)
        except requests.RequestException as err:
            print(f"[agent] network error: {err}", file=sys.stderr)
        time.sleep(HEARTBEAT_INTERVAL_S)


if __name__ == "__main__":
    main()
