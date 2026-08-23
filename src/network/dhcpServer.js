'use strict';

// ── Minimal DHCPv4 server (opt-in, direct-cable last resort) ────
// Hands a directly-cabled poster an IP so the agent doesn't have to wait
// for APIPA/link-local. Dependency-free (raw dgram + BOOTP frame building).
//
// ⚠ Runs a REAL DHCP server. On a NIC that is also on the site LAN this is
// a rogue-DHCP hazard (hands out wrong IPs to other devices). Therefore:
//   - opt-in only, never auto-starts
//   - serves exactly ONE configured subnet, offers from a tiny pool
//   - only ever run on the bench's dedicated device-facing NIC, never the
//     uplink NIC that reaches LUQA/the site network (see directLink.js)

const dgram = require('dgram');
const { ipToInt } = require('./localNics');

const MAGIC_COOKIE = 0x63825363;
const SERVER_PORT = 67;
const CLIENT_PORT = 68;

const OPT = {
  SUBNET_MASK: 1, ROUTER: 3, DNS: 6, HOSTNAME: 12,
  LEASE_TIME: 51, MSG_TYPE: 53, SERVER_ID: 54, PARAM_LIST: 55, END: 255,
};
const MSG = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 };

function intToIpBuf(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function ipStr(n) { return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`; }

// Parse the DHCP options TLV blob into { code: Buffer }.
function parseOptions(buf) {
  const opts = {};
  let i = 240; // 236 BOOTP + 4 magic cookie
  while (i < buf.length) {
    const code = buf[i++];
    if (code === 0) continue;         // pad
    if (code === OPT.END) break;
    const len = buf[i++];
    opts[code] = buf.slice(i, i + len);
    i += len;
  }
  return opts;
}

class DhcpServer {
  // cfg: { serverIp, mask, poolStart, poolEnd, leaseSeconds, dns?, gateway? }
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.sock = null;    // rx: 0.0.0.0:67 (must be wildcard to receive 255.255.255.255 DISCOVERs)
    this.txSock = null;  // tx: bound to serverIp so replies leave ONLY via the device-facing adapter
    this.leases = new Map();   // mac(hex) → { ip:int, expires:ms }
    this.running = false;
    this.stats = { discovers: 0, requests: 0, acks: 0, offers: 0 };
  }

  // Pick / reuse an address for a client MAC from the pool.
  _leaseFor(macHex) {
    const existing = this.leases.get(macHex);
    if (existing) return existing.ip;
    const start = ipToInt(this.cfg.poolStart);
    const end = ipToInt(this.cfg.poolEnd);
    const taken = new Set([...this.leases.values()].map((l) => l.ip));
    for (let ip = start; ip <= end; ip++) {
      if (!taken.has(ip)) return ip;
    }
    return null; // pool exhausted
  }

  _buildReply(req, reqOpts, yourIp, msgType) {
    const buf = Buffer.alloc(300);
    buf[0] = 2;                 // op = BOOTREPLY
    buf[1] = req[1] || 1;       // htype
    buf[2] = req[2] || 6;       // hlen
    buf[3] = 0;                 // hops
    req.copy(buf, 4, 4, 8);     // xid
    req.copy(buf, 10, 10, 12);  // secs(8-9)=0, flags(10-11) copy from request (broadcast bit)
    intToIpBuf(yourIp).copy(buf, 16);                   // yiaddr
    intToIpBuf(ipToInt(this.cfg.serverIp)).copy(buf, 20); // siaddr
    req.copy(buf, 28, 28, 44);  // chaddr (16)
    buf.writeUInt32BE(MAGIC_COOKIE, 236);

    let o = 240;
    const put = (code, data) => { buf[o++] = code; buf[o++] = data.length; data.copy(buf, o); o += data.length; };
    put(OPT.MSG_TYPE, Buffer.from([msgType]));
    put(OPT.SERVER_ID, intToIpBuf(ipToInt(this.cfg.serverIp)));
    put(OPT.LEASE_TIME, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(this.cfg.leaseSeconds || 3600); return b; })());
    put(OPT.SUBNET_MASK, intToIpBuf(ipToInt(this.cfg.mask)));
    if (this.cfg.gateway) put(OPT.ROUTER, intToIpBuf(ipToInt(this.cfg.gateway)));
    if (this.cfg.dns && this.cfg.dns.length) {
      const dnsBuf = Buffer.concat(this.cfg.dns.map((d) => intToIpBuf(ipToInt(d))));
      put(OPT.DNS, dnsBuf);
    }
    buf[o++] = OPT.END;
    return buf.slice(0, o);
  }

  _send(buf) {
    // Direct-link clients have no IP yet → broadcast the reply. CRITICAL for
    // rogue-DHCP isolation: send through txSock (bound to serverIp) so the
    // frame leaves ONLY via the device-facing adapter. Falls back to rx if
    // tx couldn't bind (still functional, less isolated).
    const s = this.txSock || this.sock;
    s.send(buf, 0, buf.length, CLIENT_PORT, '255.255.255.255', (err) => {
      if (err) this.log.warn?.(`[DHCP] send failed: ${err.message}`);
    });
  }

  // The rx socket must bind wildcard (0.0.0.0) to see broadcast DISCOVERs
  // (see start() below), which means it ALSO receives DHCP traffic from
  // every other interface on this host that shares a broadcast domain —
  // e.g. the uplink NIC picking up a neighboring device's real DHCP
  // renewal. Without filtering, we'd reply to that too: create a bogus
  // "lease" entry for a device that was never on the direct-cable link at
  // all, and in the worst case actually hand a stranger's machine an IP
  // from our pool if it picks our OFFER over its real DHCP server (the
  // rogue-DHCP hazard already flagged in the file header). A client with no
  // lease yet sends from 0.0.0.0; a renewing client sends from its current
  // (real) IP — so anything arriving from an address outside the subnet
  // we're actually serving is foreign traffic that leaked in through the
  // wildcard bind, and gets dropped before we touch it.
  _inServedSubnet(ipStr) {
    const maskInt = ipToInt(this.cfg.mask);
    const netInt = ipToInt(this.cfg.serverIp) & maskInt;
    return (ipToInt(ipStr) & maskInt) === netInt;
  }

  _onMessage(msg, rinfo) {
    if (msg.length < 240 || msg.readUInt32BE(236) !== MAGIC_COOKIE) return;
    if (rinfo && rinfo.address !== '0.0.0.0' && !this._inServedSubnet(rinfo.address)) return;
    const opts = parseOptions(msg);
    const type = opts[OPT.MSG_TYPE]?.[0];
    const macHex = msg.slice(28, 34).toString('hex');

    if (type === MSG.DISCOVER) {
      this.stats.discovers++;
      const ip = this._leaseFor(macHex);
      if (ip === null) { this.log.warn?.('[DHCP] pool exhausted'); return; }
      this._send(this._buildReply(msg, opts, ip, MSG.OFFER));
      this.stats.offers++;
      this.log.log?.(`[DHCP] OFFER ${ipStr(ip)} → ${macHex}`);
    } else if (type === MSG.REQUEST) {
      this.stats.requests++;
      const ip = this._leaseFor(macHex);
      if (ip === null) return;
      this.leases.set(macHex, { ip, expires: Date.now() + (this.cfg.leaseSeconds || 3600) * 1000 });
      this._send(this._buildReply(msg, opts, ip, MSG.ACK));
      this.stats.acks++;
      this.log.log?.(`[DHCP] ACK ${ipStr(ip)} → ${macHex}`);
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.running) return resolve();
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('error', (err) => {
        if (!this.running) reject(err);         // bind-time failure
        else this.log.error?.(`[DHCP] socket error: ${err.message}`);
      });
      sock.on('message', (m, rinfo) => { try { this._onMessage(m, rinfo); } catch (e) { this.log.warn?.('[DHCP] parse', e.message); } });
      // rx MUST be wildcard — a socket bound to serverIp won't receive
      // the 255.255.255.255 DISCOVER a client with no IP sends.
      sock.bind(SERVER_PORT, () => {
        try { sock.setBroadcast(true); } catch {}
        // tx bound to the device-facing adapter IP → replies leave only
        // through that adapter (rogue-DHCP isolation). Best-effort: if this
        // bind fails (port race), _send falls back to rx.
        const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        tx.on('error', () => { try { tx.close(); } catch {} this.txSock = null; });
        tx.bind(0, this.cfg.serverIp, () => {
          try { tx.setBroadcast(true); } catch {}
          this.txSock = tx;
          this.running = true;
          this.log.log?.(`[DHCP] serving ${this.cfg.serverIp} pool ${this.cfg.poolStart}–${this.cfg.poolEnd} (isolated tx)`);
          resolve();
        });
        // Guard: if tx bind neither succeeds nor errors quickly, still come
        // up (isolation degrades to rx-send but stays functional).
        setTimeout(() => {
          if (!this.running) {
            this.running = true;
            this.log.warn?.(`[DHCP] serving ${this.cfg.serverIp} (tx bind slow — using rx for replies)`);
            resolve();
          }
        }, 800);
      });
    });
  }

  stop() {
    this.running = false;
    try { this.sock?.close(); } catch {}
    try { this.txSock?.close(); } catch {}
    this.sock = null;
    this.txSock = null;
    this.log.log?.('[DHCP] stopped');
  }

  // Leases were never actively pruned — an expired entry just sat in the
  // map forever, so a device that renegotiated DHCP a few times over a long
  // session could look like several "different" connected devices even
  // though `leases.set(macHex, ...)` should overwrite the same key. Prune
  // on every status() read so a stale entry can't linger indefinitely.
  _pruneExpired() {
    const now = Date.now();
    for (const [mac, l] of this.leases) {
      if (l.expires < now) this.leases.delete(mac);
    }
  }

  status() {
    this._pruneExpired();
    return {
      running: this.running,
      cfg: this.cfg,
      stats: this.stats,
      leases: [...this.leases.entries()].map(([mac, l]) => ({
        mac, ip: ipStr(l.ip), expiresInSec: Math.max(0, Math.round((l.expires - Date.now()) / 1000)),
      })),
    };
  }
}

module.exports = { DhcpServer, parseOptions, MSG, OPT, MAGIC_COOKIE };
