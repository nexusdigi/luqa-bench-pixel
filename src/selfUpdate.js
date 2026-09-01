'use strict';

// Self-update — matches the pattern already documented for LUQA Benches
// (docs/architecture/luqa-benches-architecture.md §5: the bench checks for
// a newer version on its own, no inbound connection to the bench ever
// needed, same self-update idea as LUQA Desktop). This repo has no release
// pipeline (no CI, no packaged builds) — the source tree checked out on the
// Pi via `git clone` *is* the deployment, so "newer version available"
// means "package.json on origin/main has a different version than the one
// running here", and "update" means a plain `git pull` + `npm install`.
//
// Important for multi-bench fleets: this makes a change pushed to main
// reach every bench within one check interval, no manual SSH-in-and-pull
// per bench required.

const https = require('https');
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = 'nexusdigi/luqa-bench-pixel';
const PACKAGE_JSON_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const REQUEST_TIMEOUT_MS = 10_000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': REPO }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
  });
}

/**
 * Compares the running package.json version against origin/main's. Never
 * throws — a failed check (offline, GitHub hiccup) just means "no update
 * this cycle", same as every other bench-* poll in this codebase.
 */
async function checkForUpdate(currentVersion) {
  try {
    const remote = await fetchJson(PACKAGE_JSON_URL);
    if (remote.version && remote.version !== currentVersion) {
      return { available: true, currentVersion, remoteVersion: remote.version };
    }
    return { available: false };
  } catch (err) {
    console.error(`[update] check failed: ${err.message}`);
    return { available: false };
  }
}

/**
 * git pull + npm install, then exits the process — the systemd unit's
 * Restart=always brings the new code back up. Only call this between job
 * cycles (see agent.js's main loop), never mid-test.
 */
function applyUpdateAndExit() {
  const repoDir = path.join(__dirname, '..');
  console.log('[update] pulling latest…');
  execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoDir, stdio: 'inherit' });
  console.log('[update] installing dependencies…');
  execFileSync('npm', ['install', '--omit=dev'], { cwd: repoDir, stdio: 'inherit' });
  console.log('[update] restarting…');
  process.exit(0);
}

module.exports = { checkForUpdate, applyUpdateAndExit };
