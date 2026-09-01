#!/usr/bin/env node
'use strict';

/**
 * LUQA PIXEL agent — runs on the bench (Raspberry Pi), heartbeats to LUQA,
 * polls for reserved test sessions, and runs the real LED-poster QA
 * sequence against the poster wired to this bench.
 *
 * The poster's IP is never configured anywhere — this agent always finds it
 * itself via UDP discovery on its device-facing network, and always logs in
 * with the device's factory-default credentials (admin / SN2008@+, public
 * knowledge — printed on every unit). Product dimensions still come from the
 * job payload LUQA hands the agent when polling (bench_test_profiles). Local
 * config.json only identifies *this bench* to LUQA (api_base_url/slug/
 * token). See docs/architecture/luqa-benches-architecture.md §5c in the main
 * LUQA repo.
 *
 * Usage:
 *   npm install
 *   cp config.example.json config.json   # fill in slug + token
 *   node agent.js
 */

const { loadConfig, sendHeartbeat, pollJob, respondJob, reportProgress, reportMeasurements, completeSession, reportAbort, pollSession } = require('./src/luqaClient');
const { LedPosterClient } = require('./src/ledPoster/ledPosterApi');
const { runQaSequence } = require('./src/ledPoster/ledPosterQAService');
const { DEFAULT_DEVICE, STEP_ID, STEP_STATUS } = require('./src/ledPoster/ledPosterTypes');
const { discoverDevices } = require('./src/network/deviceDiscovery');
const { startHdmiTest, stopHdmiTest, isHdmiTestRunning, setHdmiState } = require('./src/hdmiTest');
const { checkForUpdate, applyUpdateAndExit } = require('./src/selfUpdate');
const { AGENT_VERSION } = require('./src/luqaClient');

const HEARTBEAT_INTERVAL_MS = 30_000;
const JOB_POLL_INTERVAL_MS = 3_000;
const HDMI_POLL_INTERVAL_MS = 2_000;
// A pushed test-flow change should reach every bench in the fleet without
// anyone SSHing in — checked between job cycles only (see main()), never
// mid-test. 10 minutes balances "changes land quickly" against not
// hammering GitHub's raw-content CDN across a growing number of benches.
const UPDATE_CHECK_INTERVAL_MS = 10 * 60_000;
// Upper bound on how long the agent keeps polling for HDMI-test start/stop
// signals after handing off to the human — not a hard deadline on the human
// (the bench stays reserved via the partial unique index on
// automated_test_sessions regardless), just a point past which this agent
// process stops spending cycles on a session someone forgot to confirm.
const HDMI_WAIT_MAX_MS = 30 * 60_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// detect/login aren't part of the formal QA sequence (STEP_ID) — they're
// reported the same way (steps.<id> = {status, info}) but happen once, up
// front, before runQaSequence even starts. LUQA's PixelPosterRun.tsx has its
// own matching CONNECT_STEPS labels — keep both in sync.
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
 * Resolve which physical device to talk to: always UDP discovery on this
 * bench's device-facing network (see src/network/deviceDiscovery.js), first
 * reply wins. No per-bench IP override anymore — the operator watches this
 * happen live in LUQA (the 'detect' progress step) instead of pre-configuring
 * it. Login always uses the device's factory-default credentials
 * (DEFAULT_DEVICE — admin / SN2008@+, public knowledge, printed on every
 * unit) since LUQA no longer stores/delivers per-device credentials either.
 */
async function resolveDevice() {
  console.log('[job] discovering the poster on the local network…');
  const found = await discoverDevices({});
  if (!found.ok || !found.devices.length) {
    return null;
  }
  const d = found.devices[0];
  console.log(`[job] discovered device at ${d.ip}:${d.port} (sn=${d.sn || '?'})`);
  return {
    ip: d.ip,
    port: d.port || DEFAULT_DEVICE.port,
    protocol: DEFAULT_DEVICE.protocol,
    username: DEFAULT_DEVICE.username,
    password: DEFAULT_DEVICE.password,
    sn: d.sn || null,
  };
}

async function runLedPosterJob(config, job) {
  const sessionId = job.session_id;

  // "Add Demo FOLDSTER 1.8" in LUQA — exercises the whole detect -> login ->
  // QA-step -> HDMI -> confirm workflow against a fabricated device, no real
  // hardware touched, for testing/optimizing the LUQA-side flow.
  if (job.is_demo) {
    return runDemoJob(config, sessionId);
  }

  const product = job.test_profile.parameters;

  const steps = {};
  const onProgress = (stepId, status, info) => {
    steps[stepId] = { status, ...(info ? { info } : {}) };
    console.log(`[job] ${sessionId} — ${stepId}: ${status}`);
    // Fire-and-forget is intentional here — a dropped progress update isn't
    // fatal (the next step's update supersedes it), and awaiting every call
    // would serialize network round-trips into the QA sequence's own timing.
    void reportProgress(config, sessionId, steps);
  };

  onProgress('detect', STEP_STATUS.RUNNING);
  const device = await resolveDevice();
  if (!device) {
    onProgress('detect', STEP_STATUS.FAILED);
    console.error('[job] no device found (discovery found nothing) — aborting');
    await reportAbort(config, sessionId, 'No poster device found — check the cable/network on the bench\'s device segment.');
    return;
  }
  onProgress('detect', STEP_STATUS.DONE, { ip: device.ip, sn: device.sn });

  const client = new LedPosterClient({ ip: device.ip, port: device.port, protocol: device.protocol });
  const loginCreds = { username: device.username, password: device.password };

  onProgress('login', STEP_STATUS.RUNNING);
  const login = await client.login(loginCreds);
  if (!login.ok) {
    onProgress('login', STEP_STATUS.FAILED);
    console.error(`[job] login to ${device.ip} failed: ${login.error}`);
    await reportAbort(config, sessionId, `Login to poster at ${device.ip} failed: ${login.error}`);
    return;
  }
  onProgress('login', STEP_STATUS.DONE);

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

  // The automated sequence's own result is only the preliminary verdict —
  // completeSession lands the session in awaiting_confirmation, not
  // completed, exactly so a human can add the visual checks (layout,
  // color/pixel quality, optional HDMI passthrough) the legacy poster QA
  // tool always required before a poster actually passed. Those checks
  // happen in the LUQA web UI now, not on this Pi — but the optional HDMI
  // test pattern itself has to come from the Pi's own HDMI output (that's
  // the whole point), so this agent sticks around watching for the
  // LUQA-side start/stop signal until a human confirms (or the wait times
  // out).
  if (completion && completion.status === 'awaiting_confirmation') {
    await waitForHumanAndServeHdmi(config, sessionId);
  }
}

// Fabricated device identity for "Add Demo FOLDSTER 1.8" — a name, not a
// real serial format, so it can never be mistaken for an actual unit.
const DEMO_DEVICE = { ip: '10.20.0.42', sn: 'FOLDSTER-DEMO-001' };
const DEMO_STEP_DELAY_MS = 700;

/**
 * Runs the exact same detect -> login -> QA-step -> awaiting_confirmation ->
 * HDMI shape as runLedPosterJob, but against nothing real: fabricated
 * detect/login, then every QA step reported done with a short delay and a
 * synthetic passing measurement. Lets an operator exercise/tune the whole
 * LUQA-side workflow without a poster wired to the bench. factory_reset is
 * reported skipped, same as the real sequence does when doFactoryReset is
 * false (see ledPosterQAService.js).
 */
async function runDemoJob(config, sessionId) {
  console.log(`[job] ${sessionId} — demo mode, no real device involved`);
  const steps = {};
  const onProgress = (stepId, status, info) => {
    steps[stepId] = { status, ...(info ? { info } : {}) };
    void reportProgress(config, sessionId, steps);
  };

  onProgress('detect', STEP_STATUS.RUNNING);
  await sleep(DEMO_STEP_DELAY_MS);
  onProgress('detect', STEP_STATUS.DONE, { ip: DEMO_DEVICE.ip, sn: DEMO_DEVICE.sn });

  onProgress('login', STEP_STATUS.RUNNING);
  await sleep(DEMO_STEP_DELAY_MS);
  onProgress('login', STEP_STATUS.DONE);

  onProgress(STEP_ID.FACTORY_RESET, STEP_STATUS.SKIPPED);

  const qaSteps = [
    STEP_ID.PRECHECK,
    STEP_ID.SOFT_RESET,
    STEP_ID.FORCE_STANDALONE,
    STEP_ID.BRIGHTNESS,
    STEP_ID.RESOLUTION,
    STEP_ID.TIME,
    STEP_ID.BUILD_PATTERN,
    STEP_ID.UPLOAD_PUBLISH,
    STEP_ID.PLAYBACK_START,
    STEP_ID.MONITOR,
  ];
  const measurements = [];
  for (const stepId of qaSteps) {
    onProgress(stepId, STEP_STATUS.RUNNING);
    await sleep(DEMO_STEP_DELAY_MS);
    onProgress(stepId, STEP_STATUS.DONE);
    measurements.push({ key: stepId, label: STEP_LABEL[stepId] || stepId, value: null, unit: null, pass: true, raw: { demo: true } });
  }
  await reportMeasurements(config, sessionId, measurements);

  const completion = await completeSession(config, sessionId, 'pass');
  if (completion) console.log(`[job] ${sessionId} — demo done, status=${completion.status}`);
  if (completion && completion.status === 'awaiting_confirmation') {
    await waitForHumanAndServeHdmi(config, sessionId);
  }
}

/**
 * Polls bench-poll-session for progress.live_control (written by the LUQA
 * web UI via the same setLiveControl()/set_bench_live_control RPC BEAM's
 * aspect-ratio switch uses) and drives the local HDMI test pattern to
 * match — starting/stopping the Chromium kiosk window as needed
 * (idempotent, never relaunched while already running) and pushing the
 * current mode/color/pattern into it via setHdmiState() so the already-open
 * kiosk tab updates without a restart (a relaunch would flicker the
 * poster). Exits once the session leaves awaiting_confirmation (human
 * confirmed/aborted it) or after HDMI_WAIT_MAX_MS, always leaving the test
 * pattern stopped on the way out.
 */
async function waitForHumanAndServeHdmi(config, sessionId) {
  console.log(`[job] ${sessionId} — awaiting human confirmation, watching for HDMI-test signal…`);
  const start = Date.now();
  let lastHeartbeatAt = Date.now();

  while (Date.now() - start < HDMI_WAIT_MAX_MS) {
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      await sendHeartbeat(config);
      lastHeartbeatAt = Date.now();
    }

    const poll = await pollSession(config, sessionId);
    if (!poll) {
      await sleep(HDMI_POLL_INTERVAL_MS);
      continue;
    }
    if (poll.status !== 'awaiting_confirmation') {
      console.log(`[job] ${sessionId} — session left awaiting_confirmation (status=${poll.status}), stopping HDMI watch`);
      break;
    }

    const liveControl = (poll.progress && poll.progress.live_control) || {};
    if (liveControl.hdmi_test) {
      if (!isHdmiTestRunning()) {
        console.log(`[job] ${sessionId} — starting HDMI test pattern`);
        const started = startHdmiTest(config);
        if (!started.ok) console.error(`[job] ${sessionId} — HDMI test failed to start: ${started.error}`);
      }
      setHdmiState({ mode: liveControl.hdmi_mode || 'cycle', color: liveControl.hdmi_color ?? null, pattern: liveControl.hdmi_pattern ?? null });
    } else if (isHdmiTestRunning()) {
      console.log(`[job] ${sessionId} — stopping HDMI test pattern`);
      stopHdmiTest();
    }

    await sleep(HDMI_POLL_INTERVAL_MS);
  }

  stopHdmiTest();
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
  let lastUpdateCheckAt = 0;
  for (;;) {
    try {
      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        await sendHeartbeat(config);
        lastHeartbeatAt = Date.now();
      }
      await pollAndRunJob(config);

      // Only ever checked/applied here, between job cycles — never while a
      // test is running (pollAndRunJob has already returned by this point).
      if (Date.now() - lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL_MS) {
        lastUpdateCheckAt = Date.now();
        const update = await checkForUpdate(AGENT_VERSION);
        if (update.available) {
          console.log(`[update] ${update.currentVersion} -> ${update.remoteVersion} available, updating…`);
          applyUpdateAndExit(); // does not return on success
        }
      }
    } catch (err) {
      console.error(`[agent] cycle error: ${err.stack || err.message}`);
    }
    await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
  }
}

main();
