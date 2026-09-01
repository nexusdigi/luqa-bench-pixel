'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { testPatternHtml } = require('./testPatternPage');

const PORT = 8973; // arbitrary, unlikely to collide with anything else on the Pi

// Raspberry Pi OS has shipped the Chromium binary under both names across
// releases (chromium-browser on Bullseye and earlier, chromium on Bookworm+)
// — try both rather than guessing the OS version.
const CHROMIUM_CANDIDATES = ['chromium-browser', 'chromium', 'chromium-browser-stable'];

let server = null;
let browserProc = null;

// What the kiosk page's /state poll currently returns — set via setState(),
// read by the already-open kiosk tab. Kept entirely in-memory: this is a
// display cue for whoever's standing at the bench, not data that needs to
// survive a restart.
let state = { mode: 'off', color: null, pattern: null };

function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(testPatternHtml());
  });
  server.listen(PORT, '127.0.0.1');
}

function stopServer() {
  if (!server) return;
  server.close();
  server = null;
}

function findChromiumBinary() {
  const { execFileSync } = require('child_process');
  for (const name of CHROMIUM_CANDIDATES) {
    try {
      execFileSync('which', [name], { stdio: 'ignore' });
      return name;
    } catch {
      // not found under this name, try the next
    }
  }
  return null;
}

/**
 * Starts the Chromium kiosk window on this Pi's own HDMI output, if not
 * already running — idempotent so the caller can call this on every poll
 * tick while hdmi_test is true without flickering the poster by relaunching
 * Chromium each time. Actual content (cycle/hold/color/pattern) is driven
 * separately via setState(), which the already-open kiosk tab picks up on
 * its own ~300ms poll — this function only owns the browser process.
 *
 * Needs a running display server (X11 or Wayland/labwc, whatever Raspberry
 * Pi OS's default desktop session provides) — DISPLAY defaults to `:0`
 * (the standard console session) but is overridable via config for setups
 * where that differs. Requires `chromium` or `chromium-browser` installed
 * (`sudo apt install -y chromium-browser` on Raspberry Pi OS).
 */
function startHdmiTest(config) {
  if (browserProc) return { ok: true, alreadyRunning: true };

  const bin = findChromiumBinary();
  if (!bin) {
    return {
      ok: false,
      error: 'No Chromium binary found (tried: ' + CHROMIUM_CANDIDATES.join(', ') + ') — install one with: sudo apt install -y chromium-browser',
    };
  }

  startServer();

  const display = (config && config.hdmi_display) || process.env.DISPLAY || ':0';
  browserProc = spawn(
    bin,
    [
      '--kiosk',
      '--noerrdialogs',
      '--disable-infobars',
      '--no-first-run',
      '--check-for-update-interval=31536000',
      `--app=http://127.0.0.1:${PORT}`,
    ],
    { env: { ...process.env, DISPLAY: display }, stdio: 'ignore', detached: true },
  );
  browserProc.on('exit', () => {
    browserProc = null;
  });
  browserProc.unref();

  return { ok: true };
}

/** Stops the HDMI test pattern and tears down the local server. Idempotent. */
function stopHdmiTest() {
  if (browserProc) {
    try {
      process.kill(-browserProc.pid); // negative pid = whole detached process group (kiosk mode can spawn helper processes)
    } catch {
      // already gone
    }
    browserProc = null;
  }
  stopServer();
  state = { mode: 'off', color: null, pattern: null };
  return { ok: true };
}

function isHdmiTestRunning() {
  return browserProc !== null;
}

/**
 * Updates what the (already-running) kiosk tab shows — the agent calls
 * this on every poll tick with whatever LUQA's live_control currently says.
 * Does not touch the Chromium process itself; call startHdmiTest() first.
 */
function setHdmiState(next) {
  state = { mode: next.mode || 'off', color: next.color ?? null, pattern: next.pattern ?? null };
}

module.exports = { startHdmiTest, stopHdmiTest, isHdmiTestRunning, setHdmiState };
