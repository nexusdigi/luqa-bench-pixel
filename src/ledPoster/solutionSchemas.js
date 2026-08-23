'use strict';

// ── Solution wire-format factories — the AD20's uploads only actually
// render if the control-file bundle matches its real internal "Solution"
// shape; a simpler made-up JSON shape uploads fine (HTTP 200 at
// transfer/end) but the device silently fails to parse it and the screen
// stays black. These shapes were captured from a real Solution publish to
// an AD20, firmware 4.7.4.1801.CTM34.2.1.
//
// Only the single-video-item path is implemented — QA always uploads
// exactly one rendered test clip, never a multi-item Plan.

const crypto = require('crypto');

const EPOCH_START = '1970-01-01T00:00:00Z+08:00';
const FAR_FUTURE_END = '4012-01-01T23:59:59Z+08:00';
const FAR_FUTURE_PAGE = '4012-01-01T24:00:00Z+08:00'; // page-level uses 24:00:00
const DEFAULT_CRON = ['0 0 0 ? * 1,2,3,4,5,6,7'];

function newUuid() {
  return crypto.randomUUID();
}

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function fullLayout() {
  return {
    width: '100%', height: '100%', x: '0%', y: '0%',
    xNum: 0.0, yNum: 0.0, widthNum: 100.0, heightNum: 100.0,
  };
}

function defaultBorder({ width = 0 } = {}) {
  return {
    aspectRatio: { type: 0, isLocked: true },
    foregroundColor: '#FF008000',
    width,
    backgroundColor: '#FFFF0000',
    style: 0,
    styleForExpress: 0,
    effects: {
      speed: 60, animation: 'CLOCK_WISE', isHeadTail: false,
      headTailSpacing: '10', speedByPixelEnable: false,
    },
  };
}

function widgetBorder() {
  return {
    ...defaultBorder({ width: 1 }),
    name: 'border',
    borderThickness: '0px,0px,0px,0px',
    cornerRadius: '2%',
    backgroundColor: '#FF000000',
    effects: {
      speed: 3, animation: 'CLOCK_WISE', isHeadTail: false,
      headTailSpacing: '10', speedByPixelEnable: false,
    },
  };
}

function defaultConstraint() {
  return {
    startTime: EPOCH_START.replace('+08:00', '+8:00'),
    endTime: FAR_FUTURE_END.replace('+08:00', '+8:00'),
    cron: DEFAULT_CRON,
  };
}

function buildPlaySolution() {
  return {
    version: '1.0.0',
    source: { type: 1, platform: 2 },
    uuid: newUuid(),
    items: [{ id: 1, name: 'local_net_program_task', layout: fullLayout(), zOrder: 1 }],
    target: [-1],
    name: 'play_solution',
    picktype: 'DEFAULT',
    itemCount: 1,
    id: 0,
  };
}

function buildScheduleConstraint() {
  return {
    id: 0,
    name: 'schedule_constraint',
    constraints: [{
      id: 0, priority: 1000, name: 'schedule_item',
      startTime: EPOCH_START, endTime: FAR_FUTURE_END,
      isNotForever: false, cron: DEFAULT_CRON,
    }],
  };
}

function buildPlaySolutionRelation() {
  return {
    id: 0,
    name: 'playSolutionRelation',
    playSolutionSource: 'play_solution.json',
    relations: [{
      taskId: 1,
      scheduleConstraints: [{
        constraintId: 0,
        constraintSource: 'schedule_constraint.json',
        playlists: [{ playlistId: 0, playlistSource: 'playlist0.json' }],
      }],
    }],
  };
}

// Type values verified against live device captures: VIDEO or PICTURE.
// Sending "IMAGE" makes the scene play for 0ms and the screen stays black.
function buildScene(item, idx) {
  const isVideo = item.type === 'VIDEO';
  const widget = {
    layout: fullLayout(),
    inAnimation: { type: 0, duration: 1000 },
    outAnimation: { type: 0, duration: 1000 },
    border: widgetBorder(),
    constraints: [defaultConstraint()],
    // metadata is only set for VIDEO — the reference publisher omits the key
    // entirely for PICTURE; sending `{}` makes the AD20 misread the scene.
    ...(isVideo ? { metadata: { volume: 100 } } : {}),
    widgetId: { value: 0 },
    displayRatio: 'FULL',
    filesize: item.filesize || 0,
    originalDataSource: item.originalDataSource || item.name || item.dataSource,
    rotation: 0,
    zOrder: 1,
    dataSource: item.dataSource,
    backgroundColor: '#00000000',
    backgroundDrawable: '',
    backgroundMusic: '',
    name: item.name || item.dataSource,
    enable: true,
    type: item.type,
    duration: item.durationMs || 5000, // ALWAYS milliseconds
    repeatCount: 1,
    id: 100000 + idx,
    uuid: newUuid(),
  };

  const container = {
    zOrder: 1,
    layout: fullLayout(),
    border: defaultBorder({ width: 0 }),
    contents: {
      widgets: [widget], widgetGroups: [], widgetContainer: [],
      enable: false, zOrder: 0, DuritionType: 0, id: 0, uuid: newUuid(),
    },
    PCType: 1,
    audioGroup: '',
    WCtype: item.type,
    DuritionType: 0,
    winId: { value: 0 },
    name: isVideo ? 'Video1' : 'Image1',
    enable: true,
    pickPolicy: 'ORDER',
    id: 200000 + idx,
    uuid: newUuid(),
  };

  return {
    constraints: [{ startTime: EPOCH_START, endTime: FAR_FUTURE_PAGE, cron: DEFAULT_CRON }],
    page: {
      border: defaultBorder({ width: 1 }),
      widgets: [],
      widgetContainers: [container],
      widgetGroups: [],
      name: idx === 0 ? 'Page1' : `Page${idx + 1}`,
      id: idx,
      uuid: newUuid(),
    },
    backgroundColor: '#00000000',
    backgroundDrawable: '',
    backgroundMusic: '',
    thumbnail: item.thumbnailFile || `${md5Hex(Buffer.from(item.dataSource))}.png`,
    name: idx === 0 ? 'Preset' : `Scene${idx + 1}`,
    enable: true,
    type: 'PAGE',
    rules: 'TIMES',
    duration: 0,
    repeatCount: 1,
    id: idx,
    uuid: newUuid(),
  };
}

function buildPlaylist0({ name, items, widthPx, heightPx, screenSn }) {
  const sceneItems = items.map((it, idx) => buildScene(it, idx));
  return {
    uuid: newUuid(),
    name,
    sceneItems,
    ProgramModel: 0,
    width: widthPx,
    height: heightPx,
    thumbpath: `C:\\\\ProgramData\\\\LuqaPixel\\\\Config\\\\${newUuid()}.png`,
    pickPolicy: 'ORDER',
    risplayScreen: screenSn || '', // typo preserved from the verified reference schema
    id: 0,
  };
}

function buildPlanlist({ name, jsonHashes, media, thumbnails }) {
  return {
    name,
    source: { type: 1, platform: 2 },
    playRelations: [{ fileName: 'playSolutionRelation.json', md5: jsonHashes['playSolutionRelation.json'] }],
    playSolutions: [{ fileName: 'play_solution.json', md5: jsonHashes['play_solution.json'] }],
    playlists: [{ fileName: 'playlist0.json', md5: jsonHashes['playlist0.json'] }],
    scheduleConstraints: [{ fileName: 'schedule_constraint.json', md5: jsonHashes['schedule_constraint.json'] }],
    medialists: [],
    resources: media.map((m) => ({ fileName: m.fileName, md5: m.md5, type: m.type, size: m.size })),
    thumbnails: thumbnails.map((t) => ({ fileName: t.fileName, size: t.size || 0, md5: t.md5 })),
  };
}

module.exports = {
  buildPlaySolution,
  buildScheduleConstraint,
  buildPlaySolutionRelation,
  buildPlaylist0,
  buildPlanlist,
  md5Hex,
  newUuid,
};
