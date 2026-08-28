#!/usr/bin/env node
'use strict';

/**
 * LUQA PIXEL agent — runs on the bench (Raspberry Pi), heartbeats to LUQA,
 * polls for reserved test sessions, and runs the real LED-poster QA
 * sequence against the poster wired to this bench.
 *
 * Everything about the poster (IP, credentials, product dimensions) comes
 * from the job payload LUQA hands the agent when polling — never from a
 * local config file. Local config.json only identifies *this bench* to
 * LUQA (api_base_url/slug/token). See docs/architecture/
 * luqa-benches-architecture.md §5c in the main LUQA repo.
 *
 * Usage:
 *   npm install
 *   cp config.example.json config.json   # fill in slug + token
 *   node agent.js
 */

const { loadConfig, sendHeartbeat, pollJob, respondJob, reportProgress, reportMeasurements, completeSession, reportAbort } = require('./src/luqaClient');
const { LedPosterClient } = require('./src/ledPoster/ledPosterApi');
const { runQaSequence } = require('./src/ledPoster/ledPosterQAService');
const { DEFAULT_DEVICE, STEP_ID } = require('./src/ledPoster/ledPosterTypes');
const { discoverDevices } = require('./src/network/deviceDiscovery');

const HEARTBEAT_INTERVAL_MS = 30_000;
const JOB_POLL_INTERVAL_MS = 3_000;

const STEP_LABEL = {
  [STEP_ID.PRECHECK]: 'Pre-check',
  [STEP_ID.FACTORY_RESET]: 'Factory reset',
  [STEP_ID.SOFT_RESET]: 'Soft reset',
  [STEP_ID.FORCE_STANDALONE]: 'Force standalone',
  [STEP_ID.BRIGHTNESS]: 'Brightness',
  [STEP_ID.RESOLUTION]: 'Resolution',
  [STEP_ID.TIME]: 'Time sync',
  [STEP_ID.BUILD_PATTERN]: 'Build test pattern',
  [STEP_ID.UPLOAD_PUBLISH]: 'Upload & publish',
  [STEP_ID.PLAYBACK_START]: 'Start playback',
  [STEP_ID.MONITOR]: 'Monitor',
};

function validateJob(job) {
  const product = job.test_profile?.parameters;
  if (!product || !product.width || !product.height || !product.resolution) {
    return 'No test profile with width/height/resolution configured for this session — set one up in LUQA (Settings → LUQA Benches) before starting a test.';
  }
  return null;
}

/**
 * Resolve which physical device to talk to: use the LUQA-configured
 * default_device.ip if set, otherwise run UDP discovery on this bench's
 * network (see src/network/deviceDiscovery.js) and take the first reply.
 */
async function resolveDevice(deviceConfig) {
  const cfg = deviceConfig || {};
  if (cfg.ip) {
    return {
      ip: cfg.ip,
      port: cfg.port || DEFAULT_DEVICE.port,
      protocol: cfg.protocol || DEFAULT_DEVICE.protocol,
      username: cfg.username || DEFAULT_DEVICE.username,
      password: cfg.password || DEFAULT_DEVICE.password,
    };
  }

  console.log('[job] no fixed device IP configured — discovering on the local network…');
  const found = await discoverDevices({});
  if (!found.ok || !found.devices.length) {
    return null;
  }
  const d = found.devices[0];
  console.log(`[job] discovered device at ${d.ip}:${d.port} (sn=${d.sn || '?'})`);
  return {
    ip: d.ip,
    port: d.port,
    protocol: cfg.protocol || DEFAULT_DEVICE.protocol,
    username: cfg.username || DEFAULT_DEVICE.username,
    password: cfg.password || DEFAULT_DEVICE.password,
  };
}

async function runLedPosterJob(config, job) {
  const sessionId = job.session_id;
  const product = job.test_profile.parameters;

  const device = await resolveDevice(job.device);
  if (!device) {
    console.error('[job] no device found (fixed IP unset and discovery found nothing) — aborting');
    await reportAbort(config, sessionId, 'No poster device found — check the cable/network and default_device config in LUQA.');
    return;
  }

  const client = new LedPosterClient({ ip: device.ip, port: device.port, protocol: device.protocol });
  const loginCreds = { username: device.username, password: device.password };

  const login = await client.login(loginCreds);
  if (!login.ok) {
    console.error(`[job] login to ${device.ip} failed: ${login.error}`);
    await reportAbort(config, sessionId, `Login to poster at ${device.ip} failed: ${login.error}`);
    return;
  }

  const steps = {};
  const onProgress = (stepId, status, info) => {
    steps[stepId] = { status, ...(info ? { info } : {}) };
    console.log(`[job] ${sessionId} — ${stepId}: ${status}`);
    // Fire-and-forget is intentional here — a dropped progress update isn't
    // fatal (the next step's update supersedes it), and awaiting every call
    // would serialize network round-trips into the QA sequence's own timing.
    void reportProgress(config, sessionId, steps);
  };

  const result = await runQaSequence(
    client,
    { product, doFactoryReset: false, ssid: job.ssid, loginCreds },
    onProgress
  );

  const measurements = Object.entries(result.report.steps || {}).map(([stepId, stepResult]) => ({
    key: stepId,
    label: STEP_LABEL[stepId] || stepId,
    value: null,
    unit: null,
    pass: stepResult && stepResult.ok === true,
    raw: stepResult,
  }));
  if (measurements.length) await reportMeasurements(config, sessionId, measurements);

  const completion = await completeSession(config, sessionId, result.ok ? 'pass' : 'fail');
  if (completion) console.log(`[job] ${sessionId} — done, status=${completion.status}`);
}

async function pollAndRunJob(config) {
  const poll = await pollJob(config);
  if (!poll || !poll.job) return;

  const job = poll.job;
  console.log(`[job] found ${job.session_code}`);

  const rejectReason = validateJob(job);
  if (rejectReason) {
    console.error(`[job] rejecting — ${rejectReason}`);
    await respondJob(config, job.session_id, false, rejectReason);
    return;
  }

  const respond = await respondJob(config, job.session_id, true);
  if (!respond) return;

  await runLedPosterJob(config, job);
}

async function main() {
  const config = loadConfig();
  console.log(`LUQA PIXEL agent starting — bench=${config.slug}, api=${config.api_base_url}`);
  // deliberate infinite loop — the agent's whole job is to run forever,
  // resilient to individual cycle failures (caught below, logged, retried
  // next interval rather than crashing the process).
  //
  // Heartbeat and job polling used to share one HEARTBEAT_INTERVAL_MS cycle,
  // meaning a freshly reserved session could sit unnoticed for up to 30s
  // before pollJob() ran again — the actual cause of "bench takes a while
  // to react" reports. Heartbeat only needs to stay comfortably under the
  // 90s online-staleness window, so it keeps its own 30s cadence; job
  // polling now runs on its own much tighter loop.
  let lastHeartbeatAt = 0;
  for (;;) {
    try {
      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        await sendHeartbeat(config);
        lastHeartbeatAt = Date.now();
      }
      await pollAndRunJob(config);
    } catch (err) {
      console.error(`[agent] cycle error: ${err.stack || err.message}`);
    }
    await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
  }
}

main();
