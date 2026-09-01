'use strict';

// Thin client for the bench-* Edge Function contract (see
// docs/architecture/luqa-benches-architecture.md §5 in the main LUQA repo).
// The agent has no Supabase Auth session (unattended hardware) — every call
// authenticates with the bench's own long-lived token via X-Bench-Token.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const REQUEST_TIMEOUT_MS = 10_000;

function loadConfig() {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  config.api_base_url = process.env.LUQA_API_BASE || config.api_base_url;
  config.slug = process.env.LUQA_BENCH_SLUG || config.slug;
  config.token = process.env.LUQA_BENCH_TOKEN || config.token;
  // Optional: pins which local NIC is wired to the test hardware (for
  // discovery + the opt-in direct-link/DHCP helper). Not required — if
  // unset, discovery broadcasts on every non-internal NIC.
  config.device_iface = process.env.LUQA_DEVICE_IFACE || config.device_iface || null;

  const missing = ['api_base_url', 'slug', 'token'].filter((k) => !config[k]);
  if (missing.length) {
    console.error(`Missing required config: ${missing.join(', ')}`);
    console.error('Copy config.example.json to config.json and fill it in, or set LUQA_API_BASE / LUQA_BENCH_SLUG / LUQA_BENCH_TOKEN.');
    process.exit(1);
  }
  return config;
}

function readCpuTempC() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return parseInt(raw.trim(), 10) / 1000.0;
  } catch {
    return null; // not a Pi, or thermal zone unavailable — fine on a dev laptop
  }
}

function readUptimeS() {
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8');
    return parseFloat(raw.split(' ')[0]);
  } catch {
    return null;
  }
}

/**
 * POST {api_base_url}/functions/v1/{functionName} with the bench token.
 * Returns the parsed JSON body on 2xx, or null (and logs) on failure —
 * every caller treats null as "try again next cycle", matching the
 * heartbeat-loop's own retry-by-polling design.
 */
function call(config, functionName, payload) {
  return new Promise((resolve) => {
    const url = new URL(`${config.api_base_url}/functions/v1/${functionName}`);
    const body = Buffer.from(JSON.stringify(payload));
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          'X-Bench-Token': config.token,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(text)); } catch { resolve(null); }
          } else {
            console.error(`[${functionName}] failed — HTTP ${res.statusCode}: ${text}`);
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', (err) => {
      console.error(`[${functionName}] network error: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

const AGENT_VERSION = require('../package.json').version;

async function sendHeartbeat(config) {
  const diagnostics = {};
  const cpuTemp = readCpuTempC();
  if (cpuTemp !== null) diagnostics.cpu_temp_c = cpuTemp;
  const uptime = readUptimeS();
  if (uptime !== null) diagnostics.uptime_s = uptime;

  const result = await call(config, 'bench-heartbeat', { slug: config.slug, agent_version: AGENT_VERSION, diagnostics });
  if (result) console.log(`[heartbeat] ok — availability=${result.availability}`);
  return result;
}

async function pollJob(config) {
  return call(config, 'bench-poll-job', { slug: config.slug });
}

async function respondJob(config, sessionId, accept, reason) {
  return call(config, 'bench-respond-job', { slug: config.slug, session_id: sessionId, accept, ...(reason ? { reason } : {}) });
}

async function reportProgress(config, sessionId, steps) {
  return call(config, 'bench-report-progress', { slug: config.slug, session_id: sessionId, progress: { steps } });
}

async function reportMeasurements(config, sessionId, measurements) {
  return call(config, 'bench-report-measurement', { slug: config.slug, session_id: sessionId, measurements });
}

async function completeSession(config, sessionId, result, extra = {}) {
  return call(config, 'bench-complete-session', { slug: config.slug, session_id: sessionId, result, ...extra });
}

async function reportAbort(config, sessionId, reason) {
  return call(config, 'bench-report-abort', { slug: config.slug, session_id: sessionId, reason });
}

/**
 * Read-only status/progress check — used after the automated sequence hands
 * off to the human (session sits in awaiting_confirmation) to watch for the
 * LUQA-side HDMI-test start/stop signal in progress.live_control, the same
 * poll-and-react shape luqa-bench-beam's live loop uses.
 */
async function pollSession(config, sessionId) {
  return call(config, 'bench-poll-session', { slug: config.slug, session_id: sessionId });
}

module.exports = {
  loadConfig,
  call,
  sendHeartbeat,
  pollJob,
  respondJob,
  reportProgress,
  reportMeasurements,
  completeSession,
  reportAbort,
  pollSession,
  AGENT_VERSION,
};
