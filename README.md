# luqa-bench-pixel

The LUQA PIXEL agent — runs on a Raspberry Pi (or Windows, as an alternative
runner) wired to LED test hardware. Maintains an outbound-only connection to
LUQA; LUQA's web/desktop/mobile clients never talk to a bench directly. Full
architecture and the API contract this agent implements: see
[`docs/architecture/luqa-benches-architecture.md`](https://github.com/nexusdigi/LUQA/blob/main/docs/architecture/luqa-benches-architecture.md)
in the main LUQA repo.

## Current status

Reference stage — proves connectivity and the full session lifecycle, not
the real product yet:
- `agent.py` heartbeats to LUQA every 30s so the bench shows up as "Online"
  with basic diagnostics (CPU temp, uptime).
- After each heartbeat it polls for a job. If LUQA has reserved this bench
  for a test session, it accepts the job and runs a **fake placeholder test
  sequence** (`FAKE_TEST_STEPS` in `agent.py` — just sleeps and reports
  fabricated progress/measurements), then reports completion. This proves
  `reserved -> running -> awaiting_confirmation` works end-to-end against a
  real device.

The actual LED-testing logic (ported from the legacy LED QA tooling) replaces
`run_fake_test_sequence()` in a later iteration — everything around it
(heartbeat, job polling, progress/measurement reporting) is the real,
permanent shape of how that will plug in.

## Setup (Raspberry Pi)

```bash
git clone git@github.com:nexusdigi/luqa-bench-pixel.git
cd luqa-bench-pixel
pip3 install -r requirements.txt
cp config.example.json config.json
```

Edit `config.json`:
- `slug` — the Bench ID you gave it in LUQA (e.g. `luqa-pixel-lme01`)
- `token` — the one-time token LUQA shows when you register this bench via
  "Add New LUQA Bench" (Global Admin only)

Then run:

```bash
python3 agent.py
```

You should see `[heartbeat] ok — availability=available` every 30 seconds,
and the bench should show as **Online** in LUQA's Benches list within a
minute.

## Running as a service (optional)

For a real deployment, run this under systemd so it survives reboots —
not set up yet in this repo (tracked as a later task alongside the real
LED-test-sequence logic).
