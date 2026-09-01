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

function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
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
 * Starts the full-screen color-cycle test pattern on this Pi's own HDMI
 * output. Idempotent — calling while already running is a no-op.
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
  return { ok: true };
}

function isHdmiTestRunning() {
  return browserProc !== null;
}

module.exports = { startHdmiTest, stopHdmiTest, isHdmiTestRunning };
