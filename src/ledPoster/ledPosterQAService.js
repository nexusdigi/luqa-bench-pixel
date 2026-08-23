'use strict';

const fs = require('fs');
const os = require('os');
const { DEFAULT_PASSWORD, STEP_ID, STEP_STATUS } = require('./ledPosterTypes');
const { buildTestPattern } = require('./testPatternBuilder');

/**
 * Best-effort parallel pre-check. Every call is independent — one failing
 * (e.g. unsupported endpoint on a given firmware) must not abort the others.
 */
async function precheckPoster(client) {
  const [versionRes, cardRes, timeRes, abnormalRes, resRes] = await Promise.all([
    client.get('/version'),
    client.get('/monitor/receivercard/info'),
    client.get('/time'),
    client.get('/play/abnormalList?length=20'),
    client.put('/video/source/inside/current/resolution/get', { displayMode: 1 }),
  ]);

  const cardInfo = cardRes.ok ? cardRes.data : null;
  const regionInfo = cardInfo && (cardInfo.receiveCardRegionInfo || cardInfo.receiverCardRegionInfo);
  const width = Array.isArray(regionInfo) && regionInfo[0] ? regionInfo[0].width : undefined;

  const abnormalList = (abnormalRes.ok && Array.isArray(abnormalRes.data)) ? abnormalRes.data
    : (abnormalRes.ok && abnormalRes.data && Array.isArray(abnormalRes.data.list)) ? abnormalRes.data.list
    : [];

  return {
    ok: true,
    // Verified against a real AD20: /version returns {aliasName,
    // androidVersion, fpga, mac, mainVersion, model, osVersion, pcbVersion,
    // productName, registerAddress, sn, supportRegion}. Neither "firmware"
    // nor "serial" exist as field names — mainVersion/sn are the actual
    // carriers. /monitor/receivercard/info has no sn/serial field at all
    // (only receiveCardRegionInfo) — the device's own serial comes from
    // /version, not the card.
    firmware: versionRes.ok && typeof versionRes.data?.mainVersion === 'string' ? versionRes.data.mainVersion : null,
    serial: versionRes.ok && typeof versionRes.data?.sn === 'string' ? versionRes.data.sn : null,
    panelWidth: width ?? null,
    currentTime: timeRes.ok && typeof (timeRes.data?.currentTime) === 'string' ? timeRes.data.currentTime : null,
    timeZone: timeRes.ok ? timeRes.data?.timeZone : null,
    currentResolution: resRes.ok ? resRes.data : null,
    abnormalCount: abnormalList.length,
    abnormalRecent: abnormalList.slice(0, 5),
    raw: { versionRes, cardRes, timeRes, abnormalRes, resRes },
  };
}

/** Step: clear all programs/solutions via the verified list+delete flow. */
async function clearPrograms(client) {
  const listRes = await client.get('/play/program/list');
  if (!listRes.ok) return { ok: false, error: listRes.error || 'Failed to list programs' };

  const programs = Array.isArray(listRes.data) ? listRes.data
    : Array.isArray(listRes.data?.solutions) ? listRes.data.solutions
    : Array.isArray(listRes.data?.list) ? listRes.data.list
    : [];

  if (!programs.length) return { ok: true, deleted: 0 };

  let deleted = 0;
  const errors = [];
  for (const p of programs) {
    const name = p.name;
    const identifier = p.identifier;
    const delRes = await client.delete('/play/program/list/delete', {
      solutions: [{ name, identifier }],
    });
    if (delRes.ok) deleted++;
    else errors.push(`${name || identifier}: ${delRes.error}`);
  }

  return { ok: errors.length === 0, deleted, total: programs.length, errors: errors.length ? errors : undefined };
}

/** Step: disable blackout/screen power schedule. */
async function clearScreenPowerSchedule(client) {
  const res = await client.post('/screen/power/policy', {
    type: 'SCREENPOWER',
    source: { type: 1, platform: 2 },
    enable: false,
    conditions: [],
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Step: reset the AP wifi password back to the QA default, preserving other fields. */
async function resetApPassword(client) {
  const getRes = await client.get('/wifi/ap/ap/account');
  if (!getRes.ok) return { ok: false, error: getRes.error || 'Failed to read AP account' };

  const updated = { ...getRes.data, password: DEFAULT_PASSWORD };
  const putRes = await client.put('/wifi/ap/ap/account', updated);
  return putRes.ok ? { ok: true } : { ok: false, error: putRes.error };
}

/** Step 3: soft reset = clear programs + blackout schedule + AP password. */
async function softReset(client) {
  const programs = await clearPrograms(client);
  const power = await clearScreenPowerSchedule(client);
  const ap = await resetApPassword(client);

  const ok = programs.ok && power.ok && ap.ok;
  return { ok, programs, power, ap };
}

// Hardcoded IP the AD20 falls back to after a factory reset, instead of
// staying a DHCP client (confirmed on real hardware). Reachable only if the
// host also has an address in 192.168.0.0/24 on the same link — see
// src/network/directLink.js, which can add one automatically.
const FACTORY_DEFAULT_IP = '192.168.0.10';

/** Step: factory reset (destructive). Caller is responsible for the 180s wait + reconnect. */
async function factoryReset(client) {
  const res = await client.post('/advance/restoreFactory', {});
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Step 4: force standalone mode (turn off HDMI splice/cascade). */
async function forceStandalone(client) {
  const getRes = await client.get('/splice/hdmi');
  if (!getRes.ok) return { ok: false, error: getRes.error || 'Failed to read splice state' };

  const setRes = await client.post('/splice/hdmi', {
    enable: false,
    info: { direction: 0, mode: 0, totalLength: 1 },
  });
  return setRes.ok ? { ok: true, previous: getRes.data } : { ok: false, error: setRes.error };
}

/** Step 5: brightness to 100%. */
async function setBrightnessFull(client) {
  const res = await client.post('/brightness', { ratio: 100, brightness: 255, solidity: true });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Step 6: set the QA resolution/refresh rate from the selected poster product. */
async function setQaResolution(client, resolutionValue) {
  if (!resolutionValue) {
    return { ok: false, error: 'No target resolution configured — select a poster product with a resolution before running QA' };
  }

  // Best-effort: read supported list first so we surface a clearer error if the
  // device doesn't support this resolution, but don't block on it.
  await client.put('/video/source/inside/support/resolution/list/get', { displayMode: 1 });

  const res = await client.post('/video/source/inside/current/resolution', {
    displayMode: 1,
    resolutionValue,
  });
  return res.ok ? { ok: true, resolutionValue } : { ok: false, error: res.error, resolutionValue };
}

/** Step 7: best-effort local time sync. Non-fatal on failure. */
async function setLocalTime(client) {
  const getRes = await client.get('/time');
  const now = new Date();
  const timeZone = (getRes.ok && getRes.data?.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const body = {
    currentTime: now.toISOString(),
    timestamp: now.getTime(),
    timeZone,
  };

  const putRes = await client.put('/time', body);
  return putRes.ok ? { ok: true } : { ok: false, error: putRes.error, nonFatal: true };
}

/**
 * Optional, safe DHCP reset for eth0. Skips automatically if already DHCP,
 * or if changing it would risk killing the current session (host IP === eth0 IP).
 */
async function safeResetEthernetDhcp(client, { currentHostIp } = {}) {
  const getRes = await client.get('/net/ethernet/info');
  if (!getRes.ok) return { ok: false, error: getRes.error || 'Failed to read ethernet info' };

  const ethernets = Array.isArray(getRes.data?.ethernets) ? getRes.data.ethernets : [];
  const eth0 = ethernets.find((e) => e.name === 'eth0');
  if (!eth0) return { ok: false, error: 'eth0 not found in ethernet info' };

  if (eth0.dhcp === true) return { ok: true, skipped: true, reason: 'eth0 already DHCP' };
  if (currentHostIp && eth0.ip === currentHostIp) {
    return { ok: true, skipped: true, reason: 'Changing eth0 would disconnect the current session' };
  }

  const putRes = await client.put('/net/ethernet/info', {
    ethernets: [{
      scopeId: eth0.scopeId ?? -1,
      name: 'eth0',
      dhcp: true,
      ip: eth0.ip || '192.168.0.10',
      mask: eth0.mask || '255.255.255.0',
      gateWay: eth0.gateWay || '192.168.0.1',
      dns: eth0.dns || ['0.0.0.0', '0.0.0.0'],
    }],
  });
  return putRes.ok ? { ok: true } : { ok: false, error: putRes.error };
}

/** Optional: poll the abnormal list for a duration, used as a post-playback health check. */
async function monitorAbnormalList(client, { durationMs = 60000, intervalMs = 5000, onTick } = {}) {
  const start = Date.now();
  const seen = [];
  while (Date.now() - start < durationMs) {
    const res = await client.get('/play/abnormalList?length=20');
    if (res.ok) {
      const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.list) ? res.data.list : [];
      if (list.length) seen.push(...list);
      if (onTick) onTick({ elapsedMs: Date.now() - start, count: list.length });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: true, abnormalCount: seen.length, abnormal: seen };
}

/**
 * Step 9: upload + publish a built test pattern (see testPatternBuilder.js).
 *
 * Flow: /play/transfer/start -> upload media to uploadMediaUrl ->
 * upload control/json files to uploadUrl -> /play/transfer/end.
 */
async function uploadAndPublish(client, pattern, onProgress) {
  const progress = (stage) => { if (onProgress) onProgress(stage); };
  const mediaSize = pattern.media.sizeBytes + pattern.thumbnail.sizeBytes;
  const controlSize = pattern.controlFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

  progress('transfer/start');
  const startRes = await client.put('/play/transfer/start', {
    deviceIdentifier: os.hostname(),
    totalSize: controlSize,
    type: 'DEFAULT',
    local: false,
    source: 0,
    solutions: { name: pattern.name, identifier: pattern.identifier },
    totalMediaSize: mediaSize,
    judgeForDevice: true,
    checkFiles: [pattern.media.fileName],
  });

  if (!startRes.ok) return { ok: false, error: startRes.error || 'transfer/start failed' };

  const uploadUrl = startRes.data?.appliedInfos?.uploadUrl;
  const uploadMediaUrl = startRes.data?.uploadMediaUrl;
  if (!uploadUrl || !uploadMediaUrl) {
    return { ok: false, error: 'transfer/start response missing uploadUrl/uploadMediaUrl' };
  }

  // The video goes to uploadMediaUrl — NOT as a literal PUT target, it's a
  // `targetDir` query param for the fixed /tools/v1/file/uploadUseBinary
  // endpoint (verified against real device traffic — see ledPosterApi.js's
  // uploadBinary doc comment). Treating it as a URL to PUT directly to means
  // every upload silently goes nowhere.
  progress(`uploading video (${pattern.media.sizeBytes} bytes)`);
  const mediaBuf = fs.readFileSync(pattern.media.filePath);
  const mediaUpload = await client.uploadBinary({ targetDir: uploadMediaUrl, fileName: pattern.media.fileName, buffer: mediaBuf, contentType: 'video/mp4' });
  if (!mediaUpload.ok) return { ok: false, error: `Media upload failed: ${mediaUpload.error}` };

  // The thumbnail goes to uploadUrl (with the JSON control files), NOT
  // uploadMediaUrl. transfer/end's thumbnailUrl is built from uploadUrl too,
  // so uploading it to uploadMediaUrl puts the file somewhere the device
  // never looked for it.
  progress(`uploading thumbnail (${pattern.thumbnail.sizeBytes} bytes)`);
  const thumbBuf = fs.readFileSync(pattern.thumbnail.filePath);
  const thumbUpload = await client.uploadBinary({ targetDir: uploadUrl, fileName: pattern.thumbnail.fileName, buffer: thumbBuf, contentType: 'image/png' });
  if (!thumbUpload.ok) return { ok: false, error: `Thumbnail upload failed: ${thumbUpload.error}` };

  // Control/solution files go to uploadUrl (same targetDir mechanism)
  for (let i = 0; i < pattern.controlFiles.length; i++) {
    const f = pattern.controlFiles[i];
    progress(`uploading ${f.fileName} (${i + 1}/${pattern.controlFiles.length})`);
    const buf = fs.readFileSync(f.filePath);
    const res = await client.uploadBinary({ targetDir: uploadUrl, fileName: f.fileName, buffer: buf, contentType: 'application/json' });
    if (!res.ok) return { ok: false, error: `Upload of ${f.fileName} failed: ${res.error}` };
  }

  progress('transfer/end');
  const endRes = await client.put('/play/transfer/end', {
    confirmedInfos: {
      identifier: pattern.identifier,
      name: pattern.name,
      planListUrl: `${uploadUrl}/planlist.json`,
      thumbnailUrl: `${uploadUrl}/${pattern.thumbnail.fileName || ''}`,
      type: 'DEFAULT',
    },
    source: { type: 1, platform: 2 },
    delayTime: 0,
    playTime: 0,
    playImmediately: true,
    isSupportMd5Checkout: false,
  });

  if (!endRes.ok) return { ok: false, error: endRes.error || 'transfer/end failed' };
  return { ok: true, identifier: pattern.identifier, name: pattern.name };
}

/** Step 10: start playback of a published solution by identifier. */
async function startPlayback(client, identifier) {
  const res = await client.put('/play/start', { identifier });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Stop playback of a solution by identifier. */
async function stopPlayback(client, identifier) {
  const res = await client.put('/play/stop', { identifier });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Run the full 11-step automated QA sequence against a logged-in client.
 *
 * @param {import('./ledPosterApi').LedPosterClient} client - already logged in
 * @param {object} opts
 * @param {object} opts.product - poster product: { name, width, height,
 *   resolution, pitch?, nit? }. Required — there is no auto-detection of
 *   panel size/resolution, the profile determines it.
 * @param {boolean} [opts.doFactoryReset]
 * @param {string} [opts.currentHostIp]
 * @param {object} opts.loginCreds - needed to re-login after a factory reset
 * @param {(stepId: string, status: string, info?: object) => void} [onProgress]
 */
async function runQaSequence(client, opts, onProgress) {
  const emit = (stepId, status, info) => { if (onProgress) onProgress(stepId, status, info); };
  const report = { steps: {} };
  let reconnectedAtFactoryDefault = false;

  const product = opts.product;
  if (!product || !product.resolution || !product.width || !product.height) {
    return { ok: false, report, error: 'No poster product selected — configure width/height/resolution before running QA.' };
  }

  // 1. Pre-check
  emit(STEP_ID.PRECHECK, STEP_STATUS.RUNNING);
  const pre = await precheckPoster(client);
  report.steps[STEP_ID.PRECHECK] = pre;
  emit(STEP_ID.PRECHECK, pre.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, pre);
  if (!pre.ok) return { ok: false, report, failedAt: STEP_ID.PRECHECK };

  // 2. Optional factory reset
  if (opts.doFactoryReset) {
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.RUNNING);
    const fr = await factoryReset(client);
    if (!fr.ok) {
      report.steps[STEP_ID.FACTORY_RESET] = fr;
      emit(STEP_ID.FACTORY_RESET, STEP_STATUS.FAILED, fr);
      return { ok: false, report, failedAt: STEP_ID.FACTORY_RESET };
    }
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.RUNNING, { waiting: true, message: 'Waiting ~180s for device reboot…' });
    await new Promise((r) => setTimeout(r, 180000));

    client.token = null;
    const originalIp = client.ip;
    let reLogin = await client.login(opts.loginCreds);
    if (!reLogin.ok) {
      // A factory reset wipes the device's network config back to a
      // hardcoded static 192.168.0.10/24 instead of staying a DHCP client
      // (confirmed on real hardware) — the old DHCP-leased IP stops
      // answering. Retry once at the known factory-default address before
      // giving up. This only reaches the device if the host also has an IP
      // in that subnet (see src/network/directLink.js).
      emit(STEP_ID.FACTORY_RESET, STEP_STATUS.RUNNING, { waiting: true, stage: `No answer at ${originalIp} — retrying at factory-default ${FACTORY_DEFAULT_IP}…` });
      client.ip = FACTORY_DEFAULT_IP;
      client.token = null;
      const fallbackLogin = await client.login(opts.loginCreds);
      if (fallbackLogin.ok) {
        reLogin = fallbackLogin;
        reconnectedAtFactoryDefault = true;
      } else {
        client.ip = originalIp;
      }
    }
    if (!reLogin.ok) {
      report.steps[STEP_ID.FACTORY_RESET] = { ok: false, error: 'Factory reset reconnect/login failed: ' + reLogin.error };
      emit(STEP_ID.FACTORY_RESET, STEP_STATUS.FAILED, report.steps[STEP_ID.FACTORY_RESET]);
      return { ok: false, report, failedAt: STEP_ID.FACTORY_RESET };
    }
    report.steps[STEP_ID.FACTORY_RESET] = reconnectedAtFactoryDefault
      ? { ok: true, reconnectedAtFactoryDefault: true, ip: client.ip }
      : { ok: true };
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.DONE, report.steps[STEP_ID.FACTORY_RESET]);
  } else {
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.SKIPPED);
  }

  // 3. Soft reset
  emit(STEP_ID.SOFT_RESET, STEP_STATUS.RUNNING);
  const soft = await softReset(client);
  report.steps[STEP_ID.SOFT_RESET] = soft;
  emit(STEP_ID.SOFT_RESET, soft.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, soft);

  // 4. Force standalone
  emit(STEP_ID.FORCE_STANDALONE, STEP_STATUS.RUNNING);
  const standalone = await forceStandalone(client);
  report.steps[STEP_ID.FORCE_STANDALONE] = standalone;
  emit(STEP_ID.FORCE_STANDALONE, standalone.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, standalone);

  // 5. Brightness 100%
  emit(STEP_ID.BRIGHTNESS, STEP_STATUS.RUNNING);
  const brightness = await setBrightnessFull(client);
  report.steps[STEP_ID.BRIGHTNESS] = brightness;
  emit(STEP_ID.BRIGHTNESS, brightness.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, brightness);

  // 6. Resolution
  emit(STEP_ID.RESOLUTION, STEP_STATUS.RUNNING);
  const resolution = await setQaResolution(client, product.resolution);
  report.steps[STEP_ID.RESOLUTION] = resolution;
  emit(STEP_ID.RESOLUTION, resolution.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, resolution);

  // 7. Local time (best-effort, non-fatal)
  emit(STEP_ID.TIME, STEP_STATUS.RUNNING);
  const time = await setLocalTime(client);
  report.steps[STEP_ID.TIME] = time;
  emit(STEP_ID.TIME, time.ok ? STEP_STATUS.DONE : STEP_STATUS.SKIPPED, time);

  // 8. Build test pattern
  emit(STEP_ID.BUILD_PATTERN, STEP_STATUS.RUNNING);
  let pattern;
  try {
    pattern = await buildTestPattern({ width: product.width, height: product.height, productName: product.name, serial: pre.serial, ssid: opts.ssid });
    report.steps[STEP_ID.BUILD_PATTERN] = { ok: true, name: pattern.name };
    emit(STEP_ID.BUILD_PATTERN, STEP_STATUS.DONE, report.steps[STEP_ID.BUILD_PATTERN]);
  } catch (err) {
    report.steps[STEP_ID.BUILD_PATTERN] = { ok: false, error: err.message };
    emit(STEP_ID.BUILD_PATTERN, STEP_STATUS.FAILED, report.steps[STEP_ID.BUILD_PATTERN]);
    return { ok: false, report, failedAt: STEP_ID.BUILD_PATTERN };
  }

  // 9. Upload/publish
  emit(STEP_ID.UPLOAD_PUBLISH, STEP_STATUS.RUNNING);
  const publish = await uploadAndPublish(client, pattern, (stage) => emit(STEP_ID.UPLOAD_PUBLISH, STEP_STATUS.RUNNING, { stage }));
  report.steps[STEP_ID.UPLOAD_PUBLISH] = publish;
  emit(STEP_ID.UPLOAD_PUBLISH, publish.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, publish);
  if (!publish.ok) return { ok: false, report, failedAt: STEP_ID.UPLOAD_PUBLISH };

  // 10. Start playback
  emit(STEP_ID.PLAYBACK_START, STEP_STATUS.RUNNING);
  const playback = await startPlayback(client, pattern.identifier);
  report.steps[STEP_ID.PLAYBACK_START] = playback;
  emit(STEP_ID.PLAYBACK_START, playback.ok ? STEP_STATUS.DONE : STEP_STATUS.FAILED, playback);

  // 11. Optional monitor
  if (opts.monitorAbnormal) {
    emit(STEP_ID.MONITOR, STEP_STATUS.RUNNING);
    const monitor = await monitorAbnormalList(client, {
      durationMs: 60000,
      onTick: (tick) => emit(STEP_ID.MONITOR, STEP_STATUS.RUNNING, tick),
    });
    report.steps[STEP_ID.MONITOR] = monitor;
    emit(STEP_ID.MONITOR, STEP_STATUS.DONE, monitor);
  } else {
    emit(STEP_ID.MONITOR, STEP_STATUS.SKIPPED);
  }

  // If the factory-reset step had to fall back to the hardcoded factory
  // default IP, flip the device back to DHCP now that everything else is
  // done — otherwise it's stranded on 192.168.0.10 outside our normal pool
  // for every future connect/scan. Done last (not right after reconnect):
  // the device renegotiates its interface as soon as this is applied, which
  // orphans this session's IP — fine now that no further steps need it.
  if (reconnectedAtFactoryDefault) {
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.RUNNING, { stage: 'Restoring DHCP on the device…' });
    const dhcpRestore = await safeResetEthernetDhcp(client, { currentHostIp: opts.currentHostIp });
    report.steps[STEP_ID.FACTORY_RESET].dhcpRestore = dhcpRestore;
    emit(STEP_ID.FACTORY_RESET, STEP_STATUS.DONE, report.steps[STEP_ID.FACTORY_RESET]);
  }

  const anyFailed = Object.values(report.steps).some((s) => s && s.ok === false);
  return { ok: !anyFailed, report, identifier: pattern.identifier };
}

module.exports = {
  runQaSequence,
  precheckPoster,
  clearPrograms,
  clearScreenPowerSchedule,
  resetApPassword,
  softReset,
  factoryReset,
  forceStandalone,
  setBrightnessFull,
  setQaResolution,
  setLocalTime,
  safeResetEthernetDhcp,
  monitorAbnormalList,
  uploadAndPublish,
  startPlayback,
  stopPlayback,
};
