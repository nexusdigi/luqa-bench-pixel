'use strict';

// Full-screen HDMI test pattern, served locally and shown via a Chromium
// kiosk window on the Pi's own HDMI output — LUQA (the web UI) is the only
// control surface, this page just follows whatever /state says. Polls
// /state every 300ms rather than opening a websocket/SSE connection —
// simplest thing that works at this update rate, no extra dependency.
//
// mode: "cycle" — the original 4s autotest loop over 5 solid colors.
// mode: "hold" + color — a solid fill.
// mode: "hold" + pattern — one of the five CSS patterns below.
// mode: "off" (or anything else) — black.
//
// No on-screen UI/labels/controls — the poster (or whatever's plugged into
// this Pi's HDMI out) is the actual display, the operator judges by eye.

const CYCLE_COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000"];
const CYCLE_INTERVAL_MS = 4000;
const POLL_INTERVAL_MS = 300;

const PATTERN_CSS = {
  grid: `
    background-color: #000;
    background-image:
      linear-gradient(#fff 2px, transparent 2px),
      linear-gradient(90deg, #fff 2px, transparent 2px);
    background-size: 10vw 10vw;
  `,
  checker: `
    background-color: #000;
    background-image:
      linear-gradient(45deg, #fff 25%, transparent 25%, transparent 75%, #fff 75%, #fff),
      linear-gradient(45deg, #fff 25%, transparent 25%, transparent 75%, #fff 75%, #fff);
    background-size: 10vw 10vw;
    background-position: 0 0, 5vw 5vw;
  `,
  gradient: `
    background: linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000);
  `,
  hstripes: `
    background-color: #000;
    background-image: repeating-linear-gradient(0deg, #fff 0, #fff 5vh, #000 5vh, #000 10vh);
  `,
  vstripes: `
    background-color: #000;
    background-image: repeating-linear-gradient(90deg, #fff 0, #fff 5vw, #000 5vw, #000 10vw);
  `,
};

function testPatternHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>LUQA HDMI Test Pattern</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  #pattern { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="pattern"></div>
<script>
  const patternCss = ${JSON.stringify(PATTERN_CSS)};
  const cycleColors = ${JSON.stringify(CYCLE_COLORS)};
  const el = document.getElementById('pattern');

  let cycleTimer = null;
  let lastKey = null; // dedupe so we don't restart the cycle interval or reset styles every poll

  function stopCycle() {
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  }

  function applyOff() {
    stopCycle();
    el.style.cssText = 'background: #000;';
  }

  function applyCycle() {
    stopCycle();
    let i = 0;
    const next = () => { el.style.cssText = 'background: ' + cycleColors[i]; i = (i + 1) % cycleColors.length; };
    next();
    cycleTimer = setInterval(next, ${CYCLE_INTERVAL_MS});
  }

  function applyHoldColor(color) {
    stopCycle();
    el.style.cssText = 'background: ' + color;
  }

  function applyHoldPattern(pattern) {
    stopCycle();
    el.style.cssText = patternCss[pattern] || 'background: #000;';
  }

  function applyState(state) {
    const key = state.mode + '|' + (state.color || '') + '|' + (state.pattern || '');
    if (key === lastKey) return;
    lastKey = key;

    if (state.mode === 'cycle') applyCycle();
    else if (state.mode === 'hold' && state.color) applyHoldColor(state.color);
    else if (state.mode === 'hold' && state.pattern) applyHoldPattern(state.pattern);
    else applyOff();
  }

  async function poll() {
    try {
      const res = await fetch('/state');
      if (res.ok) applyState(await res.json());
    } catch {
      // transient — next poll will retry
    }
  }

  poll();
  setInterval(poll, ${POLL_INTERVAL_MS});
</script>
</body>
</html>`;
}

module.exports = { testPatternHtml };
