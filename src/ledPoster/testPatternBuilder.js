'use strict';

// QA test pattern generator — renders a real 25s video with ffmpeg at the
// poster product's exact native resolution, plus the solution control files
// needed by the upload/publish flow.
//
// Text (orientation labels, resolution/SSID badges, SN watermark) is burned
// in via an ASS subtitle file + the `ass` filter, not ffmpeg's `drawtext` —
// most distro ffmpeg builds (including Raspberry Pi OS's) don't compile
// drawtext in by default, but do have libass. ASS also handles the 180°
// "BACK" rotation directly via \frz, which is simpler than compositing a
// separately-rotated sub-canvas.
//
// Rendered at the PANEL'S native resolution (e.g. 320×1080 outdoor,
// 384×1296 indoor), not an HDMI canvas size: QA always tests ONE poster
// without cascading, where the AD20 stretches the HDMI canvas to fill the
// whole panel — rendering at panel size keeps the pattern un-stretched.
//
// Unlike the desktop-app original this was ported from, ffmpeg here is a
// plain system binary (apt install ffmpeg on Raspberry Pi OS has an
// ARM-native build) rather than a bundled/packaged Electron resource — this
// agent is a headless Node process on the bench, no app bundle to ship
// binaries alongside.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const schemas = require('./solutionSchemas');

const DURATION_SEC = 25;
const FPS = 25;

// Bundled with this repo (fonts/) instead of relying on an OS-installed
// font — not guaranteed present on a fresh Raspberry Pi OS image.
const FONT_SRC = path.join(__dirname, '..', '..', 'fonts', 'Raleway-Bold.ttf');

// Plain PATH lookup by default — override with FFMPEG_PATH if a specific
// binary needs to be pinned (e.g. a statically-linked one on a minimal
// image without apt access).
function resolveFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

// Headless equivalent of the desktop app's app.getPath('userData') — a
// plain per-user data directory, no Electron involved.
function qaWorkDir() {
  const dir = path.join(os.homedir(), '.luqa-pixel', 'qa-patterns');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Isolated single-font directory for libass's `fontsdir` option. Pointing
// it at a directory with every bundled Raleway weight would expose them all
// under the same "Raleway" family name and risk libass matching the wrong
// one.
function ensureFontsDir(baseDir) {
  const dir = path.join(baseDir, 'fonts');
  const dest = path.join(dir, 'Raleway-Bold.ttf');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, fs.readFileSync(FONT_SRC));
  return dir;
}

// ffmpeg filter option values (ass=file, fontsdir=dir) need forward
// slashes, an escaped drive-letter colon on Windows, AND single-quote
// wrapping — without quotes, a space anywhere in the path makes the ass
// filter's own internal option parser (which does its own colon/space
// splitting on top of the outer filtergraph parser) misread the rest of the
// path as a totally different positional option. Verified against a real
// ffmpeg binary with a colon+space path before shipping this originally;
// kept defensive here even though a Pi's home dir is unlikely to have one.
function escForFilterArg(p) {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

function escAss(s) {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}

function patternCacheKey(width, height, sn, ssid) {
  const idHash = crypto.createHash('sha1').update(`${sn || ''}|${ssid || ''}`).digest('hex').slice(0, 8);
  return `qa-${width}x${height}-${idHash}`;
}

// Builds the ASS subtitle file burned into the pattern. Scene timing must
// match buildFfmpegArgs' concat order: 0-5s bars, 5-10s orientation card,
// 10-25s color/gray scenes. SN is shown across the whole 25s loop so the
// unit under test is identifiable at any point without waiting for the
// orientation card.
function buildAssFile(width, height, outPath, { sn, ssid } = {}) {
  const titleFont = Math.floor(width / 9);
  const edgeFont = Math.floor(width / 14);
  const tinyFont = Math.floor(width / 18);

  const midX = Math.floor(width / 2);
  const backMidY = Math.floor(height / 4);      // center of top half (rotated BACK block)
  const upY = Math.floor(height * 0.06);
  const frontMidY = Math.floor(height * 0.68);
  const downY = Math.floor(height * 0.93);

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,Raleway,${titleFont},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,5,10,10,10,1`,
    `Style: Edge,Raleway,${edgeFont},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,5,10,10,10,1`,
    `Style: Badge,Raleway,${tinyFont},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,10,10,10,1`,
    `Style: SN,Raleway,${tinyFont},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,3,10,10,10,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = (start, end, style, text) => lines.push(`Dialogue: 0,${start},${end},${style},,0,0,0,,${text}`);

  // Orientation card (5s-10s). Top half rotated 180° — reads right-side-up
  // once the poster is physically folded/mounted; bottom half normal
  // orientation.
  ev('0:00:05.00', '0:00:10.00', 'Title', `{\\an5\\pos(${midX},${backMidY})\\frz180}LUQA PIXEL\\NBACK`);
  ev('0:00:05.00', '0:00:10.00', 'Edge', `{\\an5\\pos(${midX},${upY})}UP`);
  ev('0:00:05.00', '0:00:10.00', 'Title', `{\\an5\\pos(${midX},${frontMidY})}LUQA PIXEL\\NFRONT`);
  ev('0:00:05.00', '0:00:10.00', 'Edge', `{\\an5\\pos(${midX},${downY})}DOWN`);
  ev('0:00:05.00', '0:00:10.00', 'Badge', `{\\an7\\pos(10,10)}${width}×${height}`);
  if (ssid) ev('0:00:05.00', '0:00:10.00', 'Badge', `{\\an9\\pos(${width - 10},10)}WiFi ${escAss(ssid)}`);

  // SN watermark — visible across the whole 25s loop, bottom-right.
  if (sn) ev('0:00:00.00', '0:00:25.00', 'SN', `{\\an3\\pos(${width - 10},${height - 10})}SN ${escAss(sn)}`);

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

function buildFfmpegArgs(width, height, outputPath, assPath, fontsDir) {
  const barW = Math.floor(width / 4);
  const grayValues = [32, 96, 160, 224];
  const grayBars = grayValues
    .map((v, i) => `drawbox=x=${i * barW}:y=0:w=${barW}:h=ih:color=0x${v.toString(16).padStart(2, '0').repeat(3)}:t=fill`)
    .join(',');

  const inputs = [
    ['-f', 'lavfi', '-i', `smptehdbars=size=${width}x${height}:rate=${FPS}:duration=5`],
    ['-f', 'lavfi', '-i', `color=c=black:size=${width}x${height}:rate=${FPS}:duration=5`],
    ['-f', 'lavfi', '-i', `color=c=red:size=${width}x${height}:rate=${FPS}:duration=3`],
    ['-f', 'lavfi', '-i', `color=c=lime:size=${width}x${height}:rate=${FPS}:duration=3`],
    ['-f', 'lavfi', '-i', `color=c=blue:size=${width}x${height}:rate=${FPS}:duration=3`],
    ['-f', 'lavfi', '-i', `color=c=white:size=${width}x${height}:rate=${FPS}:duration=3`],
    ['-f', 'lavfi', '-i', `color=c=black:size=${width}x${height}:rate=${FPS}:duration=3`],
  ];

  const filter = [
    `[1:v]drawbox=x=0:y=ih/2-1:w=iw:h=2:color=white@0.5:t=fill[orient]`,
    `[6:v]${grayBars}[gray]`,
    `[0:v][orient][2:v][3:v][4:v][5:v][gray]concat=n=7:v=1[seq]`,
    `[seq]ass=${escForFilterArg(assPath)}:fontsdir=${escForFilterArg(fontsDir)}[out]`,
  ].join(';');

  return [
    ...inputs.flat(),
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:v', 'libx265',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-tag:v', 'hvc1',
    // Signage/embedded hardware decoders (this AD20 included, going by a
    // real test: playback looked frozen on the first frame) tend to be far
    // less tolerant of B-frame-heavy, sparse-keyframe streams than desktop
    // players/ffmpeg itself — a decode hiccup after the first keyframe can
    // just show as "stuck", not an error. Force a keyframe every second and
        '-g', String(FPS),
    '-bf', '0',
    '-x265-params', `keyint=${FPS}:min-keyint=${FPS}:bframes=0:scenecut=0`,
    '-movflags', '+faststart',
    '-an',
    '-r', String(FPS),
    '-y',
    outputPath,
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath();
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg exited ${code}: ${stderr.slice(-500)}` });
    });
    proc.on('error', (err) => resolve({ ok: false, error: `ffmpeg spawn failed (is ffmpeg installed? apt install ffmpeg): ${err.message}` }));
  });
}

/**
 * Build the QA test pattern video plus the solution control files required
 * by the publish flow. Rendered with ffmpeg at the exact width/height of
 * the selected poster product — there is no auto-detection.
 *
 * The video (and its thumbnail) are cached per (width, height, serial,
 * ssid) under ~/.luqa-pixel/qa-patterns — re-running QA on the same unit
 * doesn't re-render.
 *
 * @param {object} opts
 * @param {number} opts.width - native panel width in px, from the poster product
 * @param {number} opts.height - native panel height in px, from the poster product
 * @param {string} [opts.productName]
 * @param {string} [opts.serial]
 * @param {string} [opts.ssid]
 * @param {string} [opts.outputDir] - defaults to ~/.luqa-pixel/qa-patterns
 */
async function buildTestPattern({ width, height, productName, serial, ssid, outputDir } = {}) {
  if (!width || !height) {
    throw new Error('No panel size configured — width/height are required before running QA');
  }

  const outDir = outputDir || qaWorkDir();
  const fontsDir = ensureFontsDir(outDir);
  const cacheKey = patternCacheKey(width, height, serial, ssid);
  const mediaFileName = `${cacheKey}.mp4`;
  const thumbnailFileName = `${cacheKey}.png`;
  const videoPath = path.join(outDir, mediaFileName);
  const thumbPath = path.join(outDir, thumbnailFileName);
  const assPath = path.join(outDir, `${cacheKey}.ass`);

  const cached = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0;
  if (!cached) {
    buildAssFile(width, height, assPath, { sn: serial, ssid });
    const args = buildFfmpegArgs(width, height, videoPath, assPath, fontsDir);
    const res = await runFfmpeg(args);
    if (!res.ok || !fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
      throw new Error(`Test pattern render failed: ${res.error || 'ffmpeg produced no output'}`);
    }
  }

  if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) {
    const thumbRes = await runFfmpeg(['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', thumbPath]);
    if (!thumbRes.ok || !fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) {
      throw new Error(`Thumbnail extraction failed: ${thumbRes.error || 'ffmpeg produced no output'}`);
    }
  }

  const identifier = crypto.randomUUID();
  const timestamp = Date.now();
  const name = `QA-Test-${timestamp}`;

  const meta = {
    width,
    height,
    durationSec: DURATION_SEC,
    productName: productName || null,
    serial: serial || null,
    ssid: ssid || null,
    colors: ['red', 'green', 'blue', 'white', 'gray'],
    cached,
  };

  const videoBytes = fs.readFileSync(videoPath);
  const thumbBytes = fs.readFileSync(thumbPath);
  const videoMd5 = schemas.md5Hex(videoBytes);
  const thumbMd5 = schemas.md5Hex(thumbBytes);

  // Byte-accurate solution schema (see solutionSchemas.js) — the AD20
  // accepts almost any JSON at transfer/end (HTTP-level success) but
  // silently fails to render a bundle it can't actually parse into a
  // Solution, which looks exactly like "nothing uploaded, screen stays
  // black" despite every step reporting success.
  const scene = {
    type: 'VIDEO',
    dataSource: mediaFileName,
    originalDataSource: mediaFileName,
    name: productName || mediaFileName,
    filesize: videoBytes.length,
    durationMs: DURATION_SEC * 1000,
    thumbnailFile: thumbnailFileName,
  };

  const rawJsons = {
    'play_solution.json': schemas.buildPlaySolution(),
    'schedule_constraint.json': schemas.buildScheduleConstraint(),
    'playSolutionRelation.json': schemas.buildPlaySolutionRelation(),
    'playlist0.json': schemas.buildPlaylist0({ name: 'playlist0', items: [scene], widthPx: width, heightPx: height, screenSn: serial || '' }),
  };

  const jsonBuffers = {};
  const jsonHashes = {};
  for (const [fileName, obj] of Object.entries(rawJsons)) {
    const buffer = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
    jsonBuffers[fileName] = buffer;
    jsonHashes[fileName] = schemas.md5Hex(buffer);
  }

  const planlistObj = schemas.buildPlanlist({
    name,
    jsonHashes,
    media: [{ fileName: mediaFileName, md5: videoMd5, type: 'VIDEO', size: videoBytes.length }],
    thumbnails: [{ fileName: thumbnailFileName, md5: thumbMd5, size: thumbBytes.length }],
  });
  jsonBuffers['planlist.json'] = Buffer.from(JSON.stringify(planlistObj, null, 2), 'utf8');

  const controlFiles = Object.entries(jsonBuffers).map(([fileName, buffer]) => {
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, buffer);
    return { fileName, filePath, sizeBytes: buffer.length };
  });

  return {
    identifier,
    name,
    outDir,
    meta,
    media: { fileName: mediaFileName, filePath: videoPath, sizeBytes: fs.statSync(videoPath).size },
    thumbnail: { fileName: thumbnailFileName, filePath: thumbPath, sizeBytes: fs.statSync(thumbPath).size },
    controlFiles,
  };
}

module.exports = { buildTestPattern, DURATION_SEC };
