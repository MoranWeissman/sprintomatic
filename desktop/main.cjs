// The sprintomatic dashboard in its own Mac window.
//
// The app doesn't hold the dashboard itself. It asks the dashboard on
// localhost:7777 if it's up, starts it from the repo (`npm start`, the same
// thing a chat's orient does) when it isn't, and shows it in a window. The
// dashboard keeps running when the app quits, just like when a chat starts
// it, so chats never lose it.
const { app, BrowserWindow, nativeTheme, shell } = require('electron');
const { spawn } = require('node:child_process');
const { mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const PORT = 7777;
const DASH_URL = `http://localhost:${PORT}/`;
const BG = '#0b1019';
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
    background: oklch(0.108 0.024 260); border-bottom: 1px solid oklch(0.40 0.030 252 / 0.85);
    font: 500 13px system-ui, sans-serif; color: oklch(0.68 0.025 244);
    -webkit-app-region: drag; user-select: none;
  }
  #app-bar::after { content: 'Sprintomatic'; }
  body:has(.ember-drawer-scrim, .schedule-scrim) #app-bar { -webkit-app-region: no-drag; }
  html body #root { padding-top: ${BAR}px; }
  html body :is(.r21-app, .ember) { min-height: calc(100vh - ${BAR}px); }
  html body :is(.ember-drawer, .ember-drawer-scrim, .schedule-scrim) { top: ${BAR}px; }
  html body :is(.r21-rail, .r21-sidewrap, .r21-topwrap, .ember-top) { user-select: none; }
  html body :is(.r21-rail, .r21-sidewrap) { border-right-color: oklch(0.40 0.030 252 / 0.85); }
  html body :is(.r21-topwrap, .ember-top) { border-bottom-color: oklch(0.40 0.030 252 / 0.85); }
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win?.show());
  app.on('activate', () => win?.show());
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(createWindow);
}
