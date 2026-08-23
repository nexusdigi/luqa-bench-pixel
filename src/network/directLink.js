'use strict';

// ── Direct-cable setup for the bench's device-facing NIC (Linux) ──
// Equivalent of the legacy tool's Windows `netsh`-based helper, ported to
// Linux's `ip` command since the bench agent runs on Raspberry Pi OS.
//
// Gives the bench's device-facing interface a static IP + a secondary
// factory-default-subnet alias, then starts the opt-in DHCP server (see
// dhcpServer.js) — so a poster plugged in directly (no site-LAN DHCP on
// that segment) gets an address immediately instead of waiting out APIPA,
// AND stays reachable at its post-factory-reset static IP.
//
// ⚠ Only ever call this against the bench's dedicated device-facing NIC,
// never its uplink NIC (the one reaching LUQA/the site network) — see
// docs/architecture/luqa-benches-architecture.md §5c for the two-NIC
// topology this assumes.

const { execFile } = require('child_process');
const { DhcpServer } = require('./dhcpServer');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Same pool shape as the legacy Windows tool: a private /24 for DHCP leases,
// plus a secondary alias in 192.168.0.0/24 so a poster that just fell back
// to its hardcoded factory-default IP (192.168.0.10, see
// ledPosterQAService.js) is still reachable without a second physical link.
const DIRECT_LINK = {
  serverIp: '192.168.99.1', mask: '255.255.255.0',
  poolStart: '192.168.99.100', poolEnd: '192.168.99.120', leaseSeconds: 3600,
  factoryHostIp: '192.168.0.5', factoryMask: '255.255.255.0',
};

let dhcpServer = null;
let configuredIface = null;

/**
 * Bring up the device-facing interface for a direct poster connection:
 * static IP + factory-default alias + opt-in DHCP server. Idempotent-ish —
 * re-adding an address that's already present is a harmless no-op error we
 * swallow, matching the legacy tool's behavior.
 */
async function startDirectLink(iface) {
  if (!iface) return { ok: false, error: 'No device-facing interface configured' };

  try {
    await run('ip', ['addr', 'add', `${DIRECT_LINK.serverIp}/24`, 'dev', iface]);
  } catch (e) {
    if (!/File exists/.test(e.message)) return { ok: false, stage: 'set-ip', error: e.message };
  }

  try {
    await run('ip', ['addr', 'add', `${DIRECT_LINK.factoryHostIp}/24`, 'dev', iface]);
  } catch { /* already present — not fatal, same as the legacy tool */ }

  try {
    await run('ip', ['link', 'set', iface, 'up']);
  } catch (e) {
    return { ok: false, stage: 'link-up', error: e.message };
  }

  dhcpServer = new DhcpServer({ ...DIRECT_LINK });
  try {
    await dhcpServer.start();
  } catch (e) {
    return { ok: false, stage: 'dhcp', error: e.message };
  }

  configuredIface = iface;
  return { ok: true, iface, serverIp: DIRECT_LINK.serverIp, factoryHostIp: DIRECT_LINK.factoryHostIp };
}

async function stopDirectLink() {
  if (dhcpServer) { dhcpServer.stop(); dhcpServer = null; }
  if (configuredIface) {
    try { await run('ip', ['addr', 'del', `${DIRECT_LINK.serverIp}/24`, 'dev', configuredIface]); } catch {}
    try { await run('ip', ['addr', 'del', `${DIRECT_LINK.factoryHostIp}/24`, 'dev', configuredIface]); } catch {}
  }
  configuredIface = null;
  return { ok: true };
}

module.exports = { startDirectLink, stopDirectLink, DIRECT_LINK };
