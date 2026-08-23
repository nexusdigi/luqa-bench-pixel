'use strict';

// ── TAURUS DISCOVERY ─────────────────────────────────────────────
//
// Source protocol: Novc.Platform.DAL.Player.Access.SysOuter.UdpScreenSearcher
// (decompiled from the manufacturer's own Express V3 control software).
//
// A TCP-connect-scan of the local /24 only finds a device if it already has
// a routable IP on the same /24 as this host — the AD20 is a DHCP *client*
// and commonly sits on a link-local (169.254.x.x) or WiFi-AP address that a
// plain scan never covers. UDP broadcast discovery works regardless of the
// exact subnet, as long as the NIC's broadcast address reaches the device.
//
//   Ports Taurus devices listen on:
//     16601  TERMINAL_LISTEN_PORT  → Screen-Service (the AD20 control plane)
//     16611  PLAYER_LISTEN_PORT    → Player service (audio/video)
//     15999  SYSSET_LISTEN_PORT    → System-settings channel
//
//   Wire format of the broadcast packet (per UdpSession.BroadcastPacket):
//     - type     : ushort  MATCHING_CODE   = 34901 (0x8855)
//     - what     : ushort  WHAT_SEARCH_ALL = 129   (0x0081)
//     - arg      : int     1
//     - sequence : int     -1
//     - body     : null, length 0
//
//   Reply: same MATCHING_CODE, what = WHAT_SEARCH_INFO (1), body = JSON
//          payload SearchResultParameter (see parseSearchResult below).
//          The most important field is `terminalEntrancePortHttps` — the
//          actual HTTPS REST port for this specific device (NOT fixed at
//          8001 — that's only a last-resort fallback, see ledPosterApi.js).

const dgram = require('dgram');
const os = require('os');

const TAURUS_PORTS = {
  TERMINAL: 16601,
  PLAYER: 16611,
  SYSSET: 15999,
  HAND: 16600,
  HAND_ALT: 16610,
};

const TAURUS_MATCHING_CODE = 34901;  // 0x8855
const TAURUS_WHAT_SEARCH = 129;      // 0x0081 (we send this)
const TAURUS_WHAT_INFO = 1;          // 0x0001 (player replies with this)

// Magic at packet offset 0..3 — 0x4E4F5641 LE bytes.
const TAURUS_MAGIC = 0x4E4F5641;

// 16-bit checksum exactly per Novc.Public.Net.Common.Misc.CheckSum: each
// byte is interpreted as SIGNED (-128..127), accumulator wraps as int16.
function checkSum16(buf, offset, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i];
    const signed = b > 127 ? b - 256 : b;     // byte → sbyte
    sum = (sum + signed) & 0xFFFF;            // accumulate
    if (sum > 0x7FFF) sum -= 0x10000;         // wrap as int16
  }
  return sum & 0xFFFF;
}

// Build the exact 24-byte (or 24+body) packet that UdpSession.packData
// produces. All multi-byte fields are little-endian.
//   [ 0:4]   uint32  magic
//   [ 4:8]   int32   sequence        (-1 for broadcast)
//   [ 8:10]  int16   type            (e.g. 34901 = MATCHING_CODE)
//   [10:12]  int16   what            (e.g. 129  = WHAT_SEARCH_ALL)
//   [12:16]  int32   arg
//   [16:20]  int32   dataLen         (== body.length, 0 if no body)
//   [20:22]  int16   dataChecksum    (over body bytes; ignored if dataLen=0)
//   [22:24]  int16   headerChecksum  (over bytes [0..22))
//   [24:..]  body                    (optional)
function buildTaurusPacket({
  sequence = -1,
  type = TAURUS_MATCHING_CODE,
  what = TAURUS_WHAT_SEARCH,
  arg = 1,
  body = null,
} = {}) {
  const bodyLen = body ? body.length : 0;
  const buf = Buffer.alloc(24 + bodyLen);

  buf.writeUInt32LE(TAURUS_MAGIC >>> 0, 0);
  buf.writeInt32LE(sequence | 0, 4);
  buf.writeUInt16LE(type & 0xFFFF, 8);
  buf.writeUInt16LE(what & 0xFFFF, 10);
  buf.writeInt32LE(arg | 0, 12);
  buf.writeInt32LE(bodyLen | 0, 16);

  if (body && bodyLen > 0) {
    body.copy(buf, 24);
    buf.writeUInt16LE(checkSum16(buf, 24, bodyLen) & 0xFFFF, 20);
  }
  buf.writeUInt16LE(checkSum16(buf, 0, 22) & 0xFFFF, 22);
  return buf;
}

// Parse the inverse — peel the 24-byte header off an incoming packet and
// return { sequence, type, what, arg, body }. Returns null if the magic
// doesn't match or the checksums don't verify.
function parseTaurusPacket(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32LE(0) !== (TAURUS_MAGIC >>> 0)) return null;
  const headerCs = buf.readUInt16LE(22);
  if ((checkSum16(buf, 0, 22) & 0xFFFF) !== headerCs) return null;
  const sequence = buf.readInt32LE(4);
  const type = buf.readUInt16LE(8);
  const what = buf.readUInt16LE(10);
  const arg = buf.readInt32LE(12);
  const dataLen = buf.readInt32LE(16);
  if (dataLen <= 0 || dataLen + 24 !== buf.length) {
    return { sequence, type, what, arg, body: null };
  }
  const dataCs = buf.readUInt16LE(20);
  if ((checkSum16(buf, 24, dataLen) & 0xFFFF) !== dataCs) return null;
  return { sequence, type, what, arg, body: buf.slice(24, 24 + dataLen) };
}

const buildTaurusSearchPacket = () => buildTaurusPacket();

const DEFAULT_PROBES = [
  { name: 'taurus-terminal-16601', port: TAURUS_PORTS.TERMINAL, payload: buildTaurusSearchPacket() },
  { name: 'taurus-player-16611', port: TAURUS_PORTS.PLAYER, payload: buildTaurusSearchPacket() },
  { name: 'taurus-sysset-15999', port: TAURUS_PORTS.SYSSET, payload: buildTaurusSearchPacket() },
];

// Real test: right after a poster reboot, basic networking (DHCP) comes up
// well before the AD20's own discovery-listener service is actually ready
// to answer the Taurus UDP broadcast — 3s was too tight in that window. 8s
// is still fine for an already-settled device (this only makes a
// slow/starting-up one more likely to still answer in time).
const DEFAULT_TIMEOUT_MS = 8000;

// ── PARSE A SINGLE REPLY ───────────────────────────────────────
// Reply is a JSON SearchResultParameter (decompiled from
// Novc.Platform.DAL.Player.Access.SysOuter.UdpScreenSearcher.OnPacketReceived).
function parseSearchResult(buf, rinfo, probeName) {
  const base = { ip: rinfo.address, port: rinfo.port, probe: probeName };

  let payloadText = null;
  const packet = parseTaurusPacket(buf);
  if (packet && packet.body) {
    payloadText = packet.body.toString('utf8').replace(/\0+$/, '').trim();
  }

  try {
    const txt = payloadText !== null
      ? payloadText
      : buf.toString('utf8').replace(/\0+$/, '').trim();
    const jsonStart = txt.indexOf('{');
    if (jsonStart >= 0) {
      const obj = JSON.parse(txt.slice(jsonStart));
      const apkName =
        rinfo.port === TAURUS_PORTS.SYSSET ? 'SystemSetting' :
        rinfo.port === TAURUS_PORTS.TERMINAL ? 'ScreenService' :
        rinfo.port === TAURUS_PORTS.PLAYER ? 'Player' :
        'Unknown';
      return {
        ...base,
        sn: obj.sn || null,
        name: obj.aliasName || obj.productName || null,
        productName: obj.productName || null,
        modelId: obj.modelId || null,
        width: obj.width || null,
        height: obj.height || null,
        ftpPort: obj.ftpPort || null,
        tcpPort: obj.tcpPort || null,
        key: obj.key || null,
        logined: !!obj.logined,
        platform: obj.platform || null,
        privacy: !!obj.privacy,
        apkName,
        // The HTTP(S) REST entry point is the most important field — this
        // is the real per-device port, replacing the hardcoded 8001 guess.
        httpsPort: obj.terminalEntrancePortHttps || null,
        websocketPort: obj.terminalEntrancePortWebSocket || null,
        raw: obj,
      };
    }
  } catch { /* fall through to unparsed */ }

  return { ...base, sn: null, name: null, rawHex: buf.toString('hex'), rawLen: buf.length, unparsed: true };
}

const parseReply = parseSearchResult;

// ── MAIN DISCOVERY ─────────────────────────────────────────────
// Binds ONE socket PER local NIC (each to <iface.address>:0 — random source
// port) and broadcasts through each individually — the only reliable way to
// ensure subnet broadcasts actually leave the right interface on a
// multi-NIC host (uplink NIC + device-facing NIC).
function discover({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probes = DEFAULT_PROBES,
  targets = null, // null → broadcast per NIC; array → unicast targets
  log = console,
  onProgress,
} = {}) {
  return new Promise((resolve) => {
    const devices = new Map();
    const sockets = [];
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) { try { s.close(); } catch {} }
      resolve([...devices.values()]);
    };

    function handleMessage(msg, rinfo, viaLabel) {
      const own = os.networkInterfaces();
      const isOwn = Object.values(own).some((list) =>
        (list || []).some((i) => i.address === rinfo.address));
      if (isOwn) return;

      const dev = parseSearchResult(msg, rinfo, `via:${viaLabel}`);
      const key = dev.sn || dev.ip;
      const existing = devices.get(key);
      if (!existing || existing.unparsed || (!existing.httpsPort && dev.httpsPort)) {
        devices.set(key, dev);
        if (onProgress) onProgress({ scanned: devices.size, total: devices.size, latest: dev });
      }
      log.log?.(`[DISCOVERY] reply from ${rinfo.address}:${rinfo.port} via ${viaLabel} → sn=${dev.sn || '?'} httpsPort=${dev.httpsPort || '?'}`);
    }

    const nics = [];
    const ifaces = os.networkInterfaces();
    for (const [name, list] of Object.entries(ifaces)) {
      for (const iface of (list || [])) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        const parts = iface.address.split('.').map((n) => parseInt(n, 10));
        const mask = iface.netmask.split('.').map((n) => parseInt(n, 10));
        if (parts.length !== 4 || mask.length !== 4) continue;
        const bcast = parts.map((p, i) => (p & mask[i]) | (~mask[i] & 0xff)).join('.');
        nics.push({ name, address: iface.address, broadcast: bcast });
      }
    }

    if (nics.length === 0) {
      log.warn?.('[DISCOVERY] no non-internal IPv4 NICs found — discovery cannot proceed');
      setTimeout(close, 100);
      return;
    }

    let readyCount = 0;
    const totalSockets = nics.length;
    function maybeBroadcast() {
      if (readyCount < totalSockets) return;
      const probeDests = targets
        ? targets.map((t) => ({ dest: t, isBroadcast: false }))
        : nics.map((n) => ({ dest: n.broadcast, isBroadcast: true, nic: n.address }));
      log.log?.(`[DISCOVERY] ${nics.length} NIC(s) ready, firing ${probeDests.length} probe set(s)`);

      for (let i = 0; i < sockets.length; i++) {
        const sock = sockets[i];
        const nic = nics[i];
        if (targets) {
          for (const t of targets) {
            for (const probe of probes) {
              sock.send(probe.payload, 0, probe.payload.length, probe.port, t, (err) => {
                if (err) log.warn?.(`[DISCOVERY] send fail ${t}:${probe.port} from ${nic.address}: ${err.message}`);
              });
            }
          }
        } else {
          for (const probe of probes) {
            sock.send(probe.payload, 0, probe.payload.length, probe.port, nic.broadcast, (err) => {
              if (err) log.warn?.(`[DISCOVERY] bcast fail ${nic.broadcast}:${probe.port} via ${nic.address}: ${err.message}`);
            });
          }
        }
      }
      setTimeout(close, timeoutMs);
    }

    function bindNic(nic) {
      const s = dgram.createSocket({ type: 'udp4' });
      sockets.push(s);
      s.on('error', (err) => log.error?.(`[DISCOVERY] socket ${nic.address}`, err));
      s.on('message', (msg, rinfo) => handleMessage(msg, rinfo, `nic:${nic.address}`));
      s.bind({ address: nic.address, port: 0 }, () => {
        try { s.setBroadcast(true); } catch {}
        log.log?.(`[DISCOVERY] bound socket to ${nic.address}:${s.address().port} (bcast ${nic.broadcast})`);
        readyCount++;
        maybeBroadcast();
      });
    }

    for (const nic of nics) bindNic(nic);
  });
}

// Unicast probe of a specific IP (e.g. a device that just got a DHCP lease,
// or a manually-entered IP outside the broadcast domain).
function probeIp(ip, opts = {}) {
  return discover({ ...opts, targets: [ip] });
}

// Resolves real devices via UDP broadcast (+ optional unicast to a known
// `subnet` IP, for devices outside the local broadcast domain).
async function discoverDevices(opts = {}) {
  const targets = [];
  if (opts.subnet && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(opts.subnet.trim())) {
    targets.push(opts.subnet.trim());
  }

  const [broadcastResults, unicastResults] = await Promise.all([
    discover({ onProgress: opts.onProgress }),
    targets.length ? discover({ targets }) : Promise.resolve([]),
  ]);

  const byKey = new Map();
  for (const d of [...broadcastResults, ...unicastResults]) {
    byKey.set(d.sn || d.ip, d);
  }

  const devices = [...byKey.values()]
    .filter((d) => !d.unparsed)
    .map((d) => ({
      ip: d.ip,
      port: d.httpsPort || 8001, // 8001 only as last-resort fallback
      sn: d.sn,
      name: d.name,
      privacy: d.privacy,
    }));

  return { ok: true, devices, scannedSubnets: [] };
}

module.exports = {
  discoverDevices,
  discover,
  probeIp,
  parseReply,
  parseSearchResult,
  DEFAULT_PROBES,
  DEFAULT_TIMEOUT_MS,
  TAURUS_PORTS,
  TAURUS_MATCHING_CODE,
  TAURUS_WHAT_SEARCH,
  TAURUS_WHAT_INFO,
  TAURUS_MAGIC,
  buildTaurusPacket,
  buildTaurusSearchPacket,
  parseTaurusPacket,
  checkSum16,
};
