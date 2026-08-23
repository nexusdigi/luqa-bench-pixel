# luqa-bench-pixel

The LUQA PIXEL agent — runs on a Raspberry Pi (or Windows, as an alternative
runner) wired to LED test hardware. Maintains an outbound-only connection to
LUQA; LUQA's web/desktop/mobile clients never talk to a bench directly. Full
architecture and the API contract this agent implements: see
[`docs/architecture/luqa-benches-architecture.md`](https://github.com/nexusdigi/LUQA/blob/main/docs/architecture/luqa-benches-architecture.md)
in the main LUQA repo.

## Current status

Reference-connectivity stage only — `agent.py` registers a heartbeat with
LUQA every 30s so the bench shows up as "Online" with basic diagnostics
(CPU temp, uptime). The actual LED-testing logic (ported from the legacy LED
QA tooling) and job dispatch (poll for a test job, run it, report results)
land in later iterations, once the LUQA-side session/job Edge Functions
(Phase 8 of the architecture doc) are built out further.

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
