'use strict';

// Shared constants for the LED poster hardware adapter.

const STEP_STATUS = {
  WAITING: 'waiting',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

const STEP_ID = {
  PRECHECK: 'precheck',
  FACTORY_RESET: 'factory_reset',
  SOFT_RESET: 'soft_reset',
  FORCE_STANDALONE: 'force_standalone',
  BRIGHTNESS: 'brightness',
  RESOLUTION: 'resolution',
  TIME: 'time',
  BUILD_PATTERN: 'build_pattern',
  UPLOAD_PUBLISH: 'upload_publish',
  PLAYBACK_START: 'playback_start',
  MONITOR: 'monitor',
};

const DEFAULT_DEVICE = {
  // 192.168.41.1 is only meaningful when joined to the poster's own WiFi AP —
  // multiple devices share this address (one per AP), and it does NOT apply
  // to a direct-cable connection (the poster is a DHCP client there, see
  // dhcpServer.js/localNics.js). Prefer discovery/DHCP-lease IPs when available.
  ip: '192.168.41.1',
  // Port is NOT fixed per-device — Taurus/AD20 units announce their real
  // HTTPS port in the UDP discovery reply (see deviceDiscovery.js). 8001 is
  // only a last-resort fallback when discovery didn't run.
  port: 8001,
  // The device expects TLS on its API port; plain HTTP gets ECONNRESET.
  protocol: 'https',
  username: 'admin',
  password: 'SN2008@+',
};

const DEFAULT_PASSWORD = 'SN2008@+';

const SESSION_EXPIRED_CODE = 39;
const SUCCESS_CODES = new Set([0, 200, '0', 'OK']);

module.exports = {
  STEP_STATUS,
  STEP_ID,
  DEFAULT_DEVICE,
  DEFAULT_PASSWORD,
  SESSION_EXPIRED_CODE,
  SUCCESS_CODES,
};
