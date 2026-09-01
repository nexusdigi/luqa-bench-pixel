'use strict';

// Self-contained full-screen color-cycle test pattern, served locally and
// shown via a Chromium kiosk window on the Pi's own HDMI output — this is
// the LUQA-native replacement for PanelCheck's "second monitor on the
// operator's laptop" HDMI test: the Pi itself drives the reference monitor,
// no laptop/StreamDeck involved, LUQA is the only control surface.
//
// Colors match what LED test patterns conventionally check for: solid
// primaries (dead/stuck pixels, color uniformity), white (backlight
// evenness), black (backlight bleed). No on-screen UI/controls — the
// operator judges by eye, start/stop comes from LUQA.

const COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000"];

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
  const colors = ${JSON.stringify(COLORS)};
  let i = 0;
  const el = document.getElementById('pattern');
  function next() {
    el.style.background = colors[i];
    i = (i + 1) % colors.length;
  }
  next();
  setInterval(next, 4000);
</script>
</body>
</html>`;
}

module.exports = { testPatternHtml, COLORS };
