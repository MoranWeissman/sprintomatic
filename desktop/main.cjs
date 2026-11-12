// The sprintomatic dashboard in its own Mac window.
//
// The app doesn't hold the dashboard itself. It asks the dashboard on
// localhost:7777 if it's up, starts it from the repo (`npm start`, the same
// thing a chat's orient does) when it isn't, and shows it in a window. The
// dashboard keeps running when the app quits, just like when a chat starts
// it, so chats never lose it.
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const PORT = 7777;
const DASH_URL = `http://localhost:${PORT}/`;
const BG = '#161512'; // the page colour, oklch(0.195 0.005 75)
const { repo } = JSON.parse(readFileSync(join(__dirname, 'repo-path.json'), 'utf8'));
const boundsFile = () => join(app.getPath('userData'), 'window.json');

// A title strip across the whole top, like other Mac apps: it holds the red,
// yellow and green buttons, and grabbing it anywhere moves the window. The
// page moves down to make room. Lives here, not in the dashboard, so the
// browser tab is never touched.
const BAR = 38;
const APP_CSS = `
  #app-bar {
    position: fixed; top: 0; left: 0; right: 0; height: ${BAR}px; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    background: oklch(0.17 0.005 75); border-bottom: 1px solid oklch(0.42 0.005 75 / 0.85);
    font: 500 13px system-ui, sans-serif; color: oklch(0.68 0.008 80);
    -webkit-app-region: drag; user-select: none;
  }
  #app-bar::after { content: 'Sprintomatic'; }
  body:has(.ember-drawer-scrim, .schedule-scrim) #app-bar { -webkit-app-region: no-drag; }
  html body #root { padding-top: ${BAR}px; }
  html body :is(.r21-app, .ember) { min-height: calc(100vh - ${BAR}px); }
  html body :is(.ember-drawer, .ember-drawer-scrim, .schedule-scrim) { top: ${BAR}px; }
  html body :is(.r21-rail, .r21-sidewrap, .r21-topwrap, .ember-top) { user-select: none; }
  html body :is(.r21-rail, .r21-sidewrap) { border-right-color: oklch(0.42 0.005 75 / 0.85); }
  html body :is(.r21-topwrap, .ember-top) { border-bottom-color: oklch(0.42 0.005 75 / 0.85); }
`;
const ADD_BAR = `document.getElementById('app-bar') || document.body.prepend(Object.assign(document.createElement('div'), { id: 'app-bar' }))`;

let win = null;
let quitting = false;

async function isUp() {
  try {
    const res = await fetch(DASH_URL + 'api/health', { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function startDashboard() {
  const logDir = join(homedir(), '.sprintomatic', 'logs');
  mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, 'dashboard.log'), 'a');
  // A Mac app opened from the Dock doesn't get the terminal's PATH, so the
  // login shell finds node and npm, wherever they were installed.
  const child = spawn('/bin/zsh', ['-lc', 'npm start'], { cwd: repo, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

async function waitForDashboard() {
  if (await isUp()) return true;
  startDashboard();
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isUp()) return true;
  }
  return false;
}

function readBounds() {
  try {
    return JSON.parse(readFileSync(boundsFile(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
}

function createWindow() {
  // A dark app: macOS then draws the thin light edge around the window.
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    ...readBounds(),
    minWidth: 1000,
    minHeight: 640,
    title: 'Sprintomatic',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: BG,
    show: false,
  });
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  wc.on('dom-ready', () => {
    wc.insertCSS(APP_CSS);
    wc.executeJavaScript(ADD_BAR);
  });
  wc.setVisualZoomLevelLimits(1, 1);
  // Links to other sites open in the normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(DASH_URL) && !url.startsWith('file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // The red button hides the window, the Mac way. Cmd+Q really quits.
  win.on('close', e => {
    writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.loadFile(join(__dirname, 'loading.html'));
  waitForDashboard().then(up => {
    if (up) win.loadURL(DASH_URL);
    else win.loadFile(join(__dirname, 'loading.html'), { query: { msg: 'The dashboard did not start. See ~/.sprintomatic/logs/dashboard.log' } });
  });
}

// ------------------------------------------------------------------
// The menu bar: how many Claude Code chats wait for the user. Chats live in
// iTerm, so this is what pulls the user back when a full-screen iTerm hides
// the Dock. The count comes from the chats' own hooks (GET /api/chats), never
// from a guess. Clicking a chat brings its iTerm tab forward.
// ------------------------------------------------------------------
const POLL_MS = 5000;
let tray = null;
let lastShown = '';

function showWindow() {
  if (!win) createWindow();
  else win.show();
  app.focus({ steal: true });
}

/** Bring the iTerm tab running on `tty` ("ttys004") to the front. */
function jumpToChat(tty) {
  // The tty goes into a script, so it must look like one ("ttys004").
  if (typeof tty !== 'string' || !/^ttys\d{1,4}$/.test(tty)) return;
  const dev = `/dev/${tty}`;
  const script = `
    tell application "iTerm2"
      activate
      if "${dev}" is "" then return
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${dev}" then
              select w
              select t
              select s
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell`;
  execFile('osascript', ['-e', script], () => {});
}

function chatLabel(c) {
  return c.task || c.story || c.repo;
}

function chatDetail(c) {
  const mins = c.minutes < 1 ? 'just now' : `${c.minutes} min ago`;
  const label = chatLabel(c);
  const parts = [c.story && c.story !== label ? c.story : null, c.repo !== label ? c.repo : null, c.why];
  if (c.why) parts.push(mins);
  return parts.filter(Boolean).join(' · ');
}

function renderTray(chats) {
  const waiting = chats ? chats.waiting : [];
  const finished = chats ? chats.finished || [] : [];
  const working = chats ? chats.working : [];
  const key = JSON.stringify([chats === null, [waiting, finished, working].map(l => l.map(c => [c.chatId, c.why, c.minutes, c.task]))]);
  if (key === lastShown) return;
  lastShown = key;

  tray.setTitle(waiting.length ? ` ${waiting.length} waiting` : '');
  tray.setToolTip(waiting.length ? `${waiting.length} chat${waiting.length === 1 ? '' : 's'} waiting for you` : 'No chat is waiting for you');
  app.dock?.setBadge(waiting.length ? String(waiting.length) : '');

  const items = [];
  if (chats === null) {
    items.push({ label: 'The dashboard is not running', enabled: false });
  } else if (waiting.length) {
    items.push({ label: 'Waiting for you', enabled: false });
    for (const c of waiting) items.push({ label: chatLabel(c), sublabel: chatDetail(c), click: () => jumpToChat(c.tty) });
  } else {
    items.push({ label: 'No chat is waiting for you', enabled: false });
  }
  for (const [title, list] of [['Finished', finished], ['Working', working]]) {
    if (!list.length) continue;
    items.push({ type: 'separator' }, { label: title, enabled: false });
    for (const c of list) {
      const sub = chatDetail(c);
      items.push({ label: chatLabel(c), ...(sub ? { sublabel: sub } : {}), click: () => jumpToChat(c.tty) });
    }
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Sprintomatic', click: showWindow },
    { label: 'Quit Sprintomatic', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function pollChats() {
  let chats = null;
  try {
    const res = await fetch(DASH_URL + 'api/chats', { signal: AbortSignal.timeout(3000) });
    if (res.ok) chats = await res.json();
  } catch {
    // The dashboard is down or restarting; say so in the menu.
  }
  renderTray(chats);
}

/** A small round dot, drawn here so the app needs no icon file. Template
 *  image: macOS colours it to match the menu bar. */
function dotIcon() {
  const n = 32; // drawn at 2x, shown at 16pt
  const px = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5);
      const a = Math.max(0, Math.min(1, 9 - d)) * 255;
      px.set([0, 0, 0, a], (y * n + x) * 4);
    }
  }
  const img = nativeImage.createFromBitmap(px, { width: n, height: n, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function startTray() {
  tray = new Tray(dotIcon());
  renderTray({ waiting: [], working: [] });
  void pollChats();
  setInterval(pollChats, POLL_MS);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(() => {
    createWindow();
    startTray();
  });
}
