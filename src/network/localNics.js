'use strict';

// ── Local NIC enumeration + classification ─────────────────────
// Which of this bench's network adapters is the device-facing one, and
// what IP does it currently carry.
//
// Background: the poster (AD20) does NOT run a DHCP server — it's a DHCP
// *client*. On a direct CAT cable with no DHCP server present, both sides
// fall back to link-local 169.254.x.x after ~30-60s. Running our own opt-in
// DHCP server (see dhcpServer.js) sidesteps that wait.

function ipToInt(ip) {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function maskToPrefix(mask) {
  const m = ipToInt(mask);
  if (m === null) return null;
  let bits = 0, x = m;
  for (let i = 31; i >= 0; i--) { if (x & (1 << i)) bits++; else break; }
  return bits;
}

// Classify a single IPv4 address on a NIC.
//   'link-local' → 169.254.x.x (APIPA / no DHCP answered)
//   'private'    → RFC1918 (10/8, 172.16/12, 192.168/16) — likely a real LAN
//   'other'      → anything else (public, CGNAT, …)
function classify(address) {
  if (address.startsWith('169.254.')) return 'link-local';
  const n = ipToInt(address);
  if (n === null) return 'other';
  const inRange = (a, bits) => (n >>> (32 - bits)) === (ipToInt(a) >>> (32 - bits));
  if (inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16)) return 'private';
  return 'other';
}

// Returns one entry per non-internal IPv4 NIC address.
//   { name, address, netmask, prefix, mac, kind, bcast }
function listLocalNics() {
  const out = [];
  const os = require('os');
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of (list || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const prefix = maskToPrefix(iface.netmask);
      const parts = iface.address.split('.').map((x) => parseInt(x, 10));
      const mask = iface.netmask.split('.').map((x) => parseInt(x, 10));
      const bcast = (parts.length === 4 && mask.length === 4)
        ? parts.map((p, i) => (p & mask[i]) | (~mask[i] & 0xff)).join('.')
        : null;
      out.push({
        name,
        address: iface.address,
        netmask: iface.netmask,
        prefix,
        mac: iface.mac,
        kind: classify(iface.address),
        bcast,
      });
    }
  }
  return out;
}

module.exports = { listLocalNics, classify, maskToPrefix, ipToInt };
