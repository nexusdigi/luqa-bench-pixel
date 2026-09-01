# luqa-bench-pixel

The LUQA PIXEL agent — runs on a Raspberry Pi (or Windows, as an alternative
runner) wired to LED poster test hardware. Maintains an outbound-only
connection to LUQA; LUQA's web/desktop/mobile clients never talk to a bench
directly. Full architecture and the API contract this agent implements: see
[`docs/architecture/luqa-benches-architecture.md`](https://github.com/nexusdigi/LUQA/blob/main/docs/architecture/luqa-benches-architecture.md)
in the main LUQA repo.

## Self-update

Between job cycles, the agent checks whether `package.json` on `origin/main`
has a different version than what's currently running (`src/selfUpdate.js`).
If so, it does a `git pull` + `npm install` and exits — the systemd unit's
`Restart=always` brings the new code straight back up. Means a change
pushed to `main` reaches every bench in the fleet within ~10 minutes, no
manual SSH-in-and-pull per bench. Only ever checked/applied between jobs,
never mid-test.

## What this does

- Heartbeats to LUQA every 30s (`agent.js`) so the bench shows up as
  "Online" with basic diagnostics (CPU temp, uptime).
- Polls for a reserved test session after each heartbeat. If LUQA has one,
  it validates the job (a test profile with product width/height/resolution
  must be configured — see below), accepts it, and runs the **real** 11-step
  LED poster QA sequence (`src/ledPoster/ledPosterQAService.js`) against the
  poster: pre-check → soft reset → force standalone → brightness → set
  resolution → time sync → build test pattern → upload/publish → start
  playback → optional post-playback monitoring.
- Reports step-by-step progress and per-step pass/fail measurements back to
  LUQA as the sequence runs, then reports completion — which lands the
  session in `awaiting_confirmation`, not `completed`: a human still has to
  add the visual checks (layout, color/pixel quality, optional HDMI
  passthrough) in the LUQA web UI before the result is final, same as
  PanelCheck always required.
- While waiting on that human confirmation, watches for an HDMI-test
  start/stop signal from LUQA and, when asked, shows a full-screen
  color-cycle test pattern on **this Pi's own HDMI output** (`src/hdmiTest/`)
  — replaces PanelCheck's "second monitor on the operator's laptop" HDMI
  test now that the bench itself is the thing plugged into the reference
  monitor. Needs Chromium installed (`sudo apt install -y chromium-browser`)
  and a running desktop session (`DISPLAY`, defaults to `:0`).

The hardware-adapter logic (`src/ledPoster/`, `src/network/`) is ported from
LUQA's previously separate LED-poster QA tooling, adapted to run headless on
a Pi instead of inside a desktop app — see the architecture doc's §5c for
why this repo is Node.js rather than a scripting-language reference agent.

## What's still local vs. what's LUQA-managed

**Local config.json holds only this bench's own identity** — which LUQA
project to talk to and its own auth token. It does **not** hold the poster's
IP, login, or product dimensions — that's all LUQA-managed (`benches.default_device`
+ `bench_test_profiles`, editable in LUQA's UI) and delivered to the agent
as part of the job payload when it polls. If no fixed device IP is
configured in LUQA, the agent falls back to UDP discovery on its local
network to find the poster automatically.

## Setup (Raspberry Pi)

```bash
sudo apt install -y ffmpeg
git clone git@github.com:nexusdigi/luqa-bench-pixel.git
cd luqa-bench-pixel
npm install
cp config.example.json config.json
```

Edit `config.json`:
- `slug` — the Bench ID you gave it in LUQA (e.g. `luqa-pixel-lme01`)
- `token` — the one-time token LUQA shows when you register this bench via
  "Add New LUQA Bench" (Global Admin only)
- `device_iface` — optional; pins which network interface is wired to the
  poster (for discovery + the opt-in direct-link/DHCP helper). Leave `null`
  to broadcast discovery on every interface.

Then run:

```bash
node agent.js
```

You should see `[heartbeat] ok — availability=available` every 30 seconds,
and the bench should show as **Online** in LUQA's Benches list within a
minute.

## Networking: how the poster gets connected

Recommended bench topology (see architecture doc §5c for the full writeup):
the Pi has **two** network interfaces — one uplink (WiFi or onboard
Ethernet) reaching the site LAN/LUQA backend, and one dedicated interface
(e.g. a cheap USB-Ethernet adapter) cabled directly to the poster. This
keeps the poster's own network segment physically isolated from the site
LAN, with the Pi as the only bridge — consistent with the network-isolation
design already documented for LUQA Benches generally.

On that dedicated interface, two connection modes are supported, both
ported from the legacy tooling:

- **Existing LAN/switch**: the poster gets its IP from whatever DHCP is
  already on that segment (or a static IP you assign it) — `src/network/
  deviceDiscovery.js` finds it via the vendor's UDP broadcast discovery
  protocol, no manual IP entry needed.
- **Direct cable, no DHCP present**: `src/network/directLink.js` (+
  `dhcpServer.js`) gives the Pi's device-facing interface a static IP and
  runs a small opt-in DHCP server just for that segment, so the poster gets
  a lease immediately instead of falling back to link-local after ~30-60s.
  Includes a secondary IP alias so a poster that just factory-reset (which
  drops it to a hardcoded static IP instead of staying a DHCP client) stays
  reachable too.

This logic is dependency-free (raw UDP sockets, no npm networking package),
carried over as-is from the previously separate, already-working tooling
this feature replaces.

## Open questions (not yet resolved — see architecture doc §10)

- **Stream Deck / Companion integration**: the legacy tooling was
  operator-triggered via a Stream Deck through Bitfocus Companion's Generic
  HTTP module, hitting a local HTTP server. Whether/how LUQA PIXEL exposes
  an equivalent trigger surface is still open.
- **"External" test pattern**: whether the QA video should always be
  rendered locally on the bench (as it is now, via ffmpeg —
  `src/ledPoster/testPatternBuilder.js`) or should support being sourced
  from elsewhere is still open.

## Current status

Reference-hardware-verified for connectivity and the session lifecycle
(heartbeat → job dispatch → progress → measurements → awaiting confirmation,
proven end-to-end against a real bench). The LED poster QA sequence itself
(this README's "What this does" section) is ported and loads cleanly but is
**not yet verified against real poster hardware** — that's the next
concrete test once a poster is wired up to a bench.

## Running as a service (optional)

For a real deployment, run this under systemd so it survives reboots:

```bash
sudo cp luqa-bench-pixel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luqa-bench-pixel
journalctl -u luqa-bench-pixel -f   # follow logs
```

Edit `luqa-bench-pixel.service` first if you didn't clone this into the
default `pi` user's home directory — check `User=`/`WorkingDirectory=`.
