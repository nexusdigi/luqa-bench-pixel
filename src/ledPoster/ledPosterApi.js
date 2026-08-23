'use strict';

const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { SESSION_EXPIRED_CODE, SUCCESS_CODES } = require('./ledPosterTypes');

const BASE_PATH = '/terminal/core/v1';
const TOOLS_PATH = '/terminal/tools/v1';

// Self-signed cert on the AD20 — reject validation. keepAlive is important:
// the AD20 firmware appears to RST mid-response when a fresh TLS handshake
// happens too often (observed on endpoints like /screen/shot/get), so a
// shared keep-alive agent (instead of a new connection per request) avoids
// that failure mode.
const INSECURE_AGENT = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 4,
});

function randomClientId() {
  return 'luqa-pixel-' + crypto.randomBytes(8).toString('hex');
}

function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.token,
    payload.access_token,
    payload.accessToken,
    payload.data && payload.data.token,
    payload.data && payload.data.access_token,
    payload.data && payload.data.accessToken,
    payload.result && payload.result.token,
  ];
  return candidates.find((v) => typeof v === 'string' && v.length > 0) || null;
}

/**
 * One client instance = one authenticated session against a single device.
 */
class LedPosterClient {
  constructor({ ip, port = 8001, protocol = 'https' }) {
    this.ip = ip;
    this.port = port;
    this.protocol = protocol;
    this.token = null;
  }

  /**
   * Low-level request. Returns a normalized envelope:
   * { ok, status, data, raw, error, sessionExpired }
   *
   * @param {string} method
   * @param {string} path - path under the core API base, or a full URL if `fullUrl` is set
   * @param {object} [opts]
   * @param {object|Buffer|string} [opts.body]
   * @param {object} [opts.headers]
   * @param {boolean} [opts.fullUrl] - if true, `path` is used as a complete URL
   * @param {string} [opts.contentType]
   * @param {number} [opts.timeoutMs]
   */
  request(method, path, opts = {}) {
    // 20s: fresh-poster logins and calls competing for keepAlive sockets can
    // hit ECONNABORTED on weak hardware/slower links with a tighter budget.
    // Binary uploads override this with their own larger one.
    const { body, headers = {}, fullUrl = false, contentType, timeoutMs = 20000 } = opts;

    let url;
    if (fullUrl) {
      url = new URL(path);
    } else {
      url = new URL(`${this.protocol}://${this.ip}:${this.port}${BASE_PATH}${path}`);
    }

    const isBinary = Buffer.isBuffer(body) || (typeof body === 'string' && contentType && contentType !== 'application/json');
    let payload = null;
    const reqHeaders = { ...headers };

    if (body !== undefined && body !== null) {
      if (isBinary) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
        reqHeaders['Content-Type'] = contentType || 'application/octet-stream';
      } else {
        payload = Buffer.from(JSON.stringify(body));
        reqHeaders['Content-Type'] = 'application/json';
      }
      reqHeaders['Content-Length'] = String(payload.length);
    }

    if (this.token) reqHeaders['Authorization'] = this.token;

    const transport = url.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers: reqHeaders,
          rejectUnauthorized: false, // accept self-signed certs (device default)
          agent: url.protocol === 'https:' ? INSECURE_AGENT : undefined,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve(this._normalize(res.statusCode, buf));
          });
        }
      );

      req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
      req.on('error', (err) => {
        resolve({ ok: false, status: 0, error: err.message || 'Network error' });
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  _normalize(status, buf) {
    let raw = buf;
    let parsed = null;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      // not JSON (e.g. binary thumbnail response, or empty body) — leave parsed = null
    }

    if (status < 200 || status >= 300) {
      return { ok: false, status, raw, error: `HTTP ${status}` };
    }

    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      const code = parsed.code;
      if (code === SESSION_EXPIRED_CODE) {
        return { ok: false, status, raw, data: parsed, error: 'Session expired', sessionExpired: true };
      }
      if (!SUCCESS_CODES.has(code)) {
        return { ok: false, status, raw, data: parsed, error: parsed.message || `Device error code ${code}` };
      }
      return { ok: true, status, raw, data: 'data' in parsed ? parsed.data : parsed };
    }

    // No envelope — return parsed JSON (or raw buffer if not JSON) as-is
    return { ok: true, status, raw, data: parsed !== null ? parsed : raw };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  put(path, body, opts) { return this.request('PUT', path, { ...opts, body }); }
  delete(path, body, opts) { return this.request('DELETE', path, { ...opts, body }); }

  /**
   * Upload raw bytes via the tools API (outside the core base path).
   * PUT /terminal/tools/v1/file/uploadUseBinary?targetDir=...&fileName=...
   * targetDir slashes are kept raw (not %2F-encoded) per device requirements.
   */
  uploadBinary({ targetDir, fileName, buffer, contentType }) {
    const safeFileName = encodeURIComponent(fileName);
    const url = `${this.protocol}://${this.ip}:${this.port}${TOOLS_PATH}/file/uploadUseBinary?targetDir=${targetDir}&fileName=${safeFileName}`;
    return this.request('PUT', url, { fullUrl: true, body: buffer, contentType: contentType || 'application/octet-stream' });
  }

  async login({ username, password, sn = '', clientId, clientName }) {
    const body = {
      username,
      password,
      // Only send sn when we actually have one. The AD20 validates the field
      // when it's PRESENT (even empty string) and rejects with "invalid sn" —
      // confirmed against real hardware: login with an empty sn field fails,
      // omitting it entirely succeeds. sn is normally still empty at first
      // login, before a pre-check has had a chance to read + persist the
      // real device serial.
      ...(sn ? { sn } : {}),
      clientId: clientId || randomClientId(),
      clientName: clientName || os.hostname(),
      loginType: 9,
      source: { type: 0, platform: 2, platformVersion: '1.0.0' },
    };

    const res = await this.request('POST', '/login', { body });
    if (!res.ok) return res;

    const token = extractToken(res.data) || extractToken(res.raw && safeJson(res.raw));
    if (!token) {
      return { ok: false, status: res.status, raw: res.raw, error: 'Login succeeded but no token found in response' };
    }
    this.token = token;
    return { ok: true, status: res.status, data: { token } };
  }
}

function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}

module.exports = { LedPosterClient, randomClientId };
