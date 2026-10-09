import { app, BrowserWindow, ipcMain, dialog, safeStorage, Tray, Menu, nativeImage, powerMonitor, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { importProfile } from './profile.mjs';
import { detectEngine } from './launcher.mjs';
import { VPN } from './vpn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const development = !app.isPackaged && process.env.DROPOVPN_DEV === '1';
const uiURL = development ? 'http://127.0.0.1:5173/' : new URL('../dist/index.html', import.meta.url).href;
app.setName('DropoVPN');
if (process.env.DROPOVPN_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.DROPOVPN_TEST_DATA);
let window, tray, store, vpn, engine, quitting = false;
let importsReady = false, importingFiles = false;
const pendingImports = new Set();
function queueProfileFiles(files, directory = process.cwd()) {
  for (const filename of files) if (typeof filename === 'string' && !filename.startsWith('-') && path.extname(filename).toLowerCase() === '.ovpn') pendingImports.add(path.resolve(directory, filename));
  if (importsReady) void flushProfileFiles();
}
app.on('open-file', (event, filename) => { event.preventDefault(); queueProfileFiles([filename]); });
queueProfileFiles(process.argv.slice(1));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, directory) => { queueProfileFiles(argv.slice(1), directory); window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('DropoVPN could not start', error.message); app.exit(1); });
}

function snapshot() {
  return { profiles: store.list(), settings: store.data.settings, connection: { ...vpn.state }, logs: vpn.logs, engine, platform: process.platform, vaultAvailable: safeStorage.isEncryptionAvailable(), version: app.getVersion() };
}
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('dropovpn:changed', snapshot());
  if (tray) {
    tray.setToolTip(`DropoVPN — ${vpn.state.status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open DropoVPN', click: () => window.show() },
      { label: vpn.state.status === 'connected' ? 'Connected' : 'VPN: ' + vpn.state.status, enabled: false },
      { label: 'Disconnect', enabled: !!vpn.session || !!vpn.retryTimer || vpn.state.status === 'credentials-required', click: () => vpn.disconnect() },
      { type: 'separator' }, { label: 'Quit DropoVPN', click: () => app.quit() }
    ]));
  }
}
function handle(channel, fn) {
  ipcMain.handle('dropovpn:' + channel, async (event, ...args) => {
    const sender = event.senderFrame;
    if (event.sender !== window?.webContents || sender !== window.webContents.mainFrame || sender.url !== uiURL) throw new Error('Untrusted request.');
    try { const value = await fn(...args); publish(); return { ok: true, value }; }
    catch (error) { return { ok: false, error: error.message || 'The operation could not be completed.' }; }
  });
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid profile.'); return value; }

async function importFiles(filenames) {
  const imported = [], errors = [];
  for (const filename of filenames) {
    try { const parsed = importProfile(filename); imported.push(store.add(path.basename(filename, path.extname(filename)), parsed)); vpn.log(`Imported profile: ${path.basename(filename)}.`); }
    catch (error) { errors.push(`${path.basename(filename)}: ${error.message}`); }
  }
  publish();
  if (errors.length) await dialog.showMessageBox(window, { type: 'warning', message: 'Some profiles could not be imported', detail: errors.join('\n\n') });
  return imported;
}
async function flushProfileFiles() {
  if (importingFiles) return;
  importingFiles = true;
  try {
    while (pendingImports.size) {
      const files = [...pendingImports]; pendingImports.clear();
      window.show(); window.focus(); await importFiles(files);
    }
  } catch (error) { vpn.log(`Profile import failed: ${error.message}`, 'error'); }
  finally { importingFiles = false; }
}

async function start() {
  store = new Store(app.getPath('userData'), safeStorage); engine = await detectEngine(store.data.settings.enginePath);
  vpn = new VPN({ store }); vpn.on('change', publish);
  window = new BrowserWindow({ width: 1160, height: 820, minWidth: 900, minHeight: 680, title: 'DropoVPN', backgroundColor: '#f6f7f9', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden', trafficLightPosition: { x: 22, y: 23 }, ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#f6f7f9', symbolColor: '#333b4b', height: 44 } } : {}), webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!quitting && store.data.settings.minimizeToTray && tray) { event.preventDefault(); window.hide(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'DropoVPN', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] }
  ]));
  // An inline SVG produces a crisp monochrome tray icon on either platform.
  const traySVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><path fill="black" d="M11 1C8 5 4 9 4 13a7 7 0 0014 0c0-4-4-8-7-12zm-1 15l-3-3 1.5-1.5L10 13l4-4 1.5 1.5z"/></svg>';
  let trayImage = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(traySVG).toString('base64'));
  // Electron nativeImage does not support SVG on every OS. Use a bundled PNG.
  if (trayImage.isEmpty()) trayImage = nativeImage.createFromPath(path.join(here, '../assets/tray.png'));
  trayImage = trayImage.resize({ width: 22, height: 22 }); trayImage.setTemplateImage(process.platform === 'darwin');
  tray = new Tray(trayImage); tray.on('click', () => window.show());

  handle('snapshot', () => snapshot());
  handle('import', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Import an OpenVPN profile', filters: [{ name: 'OpenVPN profile', extensions: ['ovpn'] }], properties: ['openFile', 'multiSelections'] });
    if (selection.canceled) return [];
    return importFiles(selection.filePaths);
  });
  handle('remove', async value => {
    id(value); const profile = store.profile(value);
    if (vpn.state.profileId === value && !['disconnected', 'error'].includes(vpn.state.status)) throw new Error('Disconnect this profile before removing it.');
    const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Remove profile'], defaultId: 0, cancelId: 0, message: `Remove ${profile.name}?`, detail: 'The imported profile and its saved password will be deleted from DropoVPN.' });
    if (answer.response === 1) store.remove(value);
  });
  handle('forget', value => { store.forget(id(value)); if (vpn.session?.id === value) vpn.session.credentials = null; });
  handle('rename', (value, name) => { if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\r\n\0]/.test(name)) throw new Error('Enter a name between 1 and 80 characters.'); store.profile(id(value)).name = name.trim(); store.persist(); });
  handle('connect', async value => { id(value); engine = await detectEngine(store.data.settings.enginePath); await vpn.connect(value, null, engine); });
  handle('disconnect', () => vpn.disconnect());
  handle('credentials', async value => {
    if (!value || typeof value.username !== 'string' || typeof value.password !== 'string' || typeof value.remember !== 'boolean' || typeof value.privateKey !== 'boolean') throw new Error('Invalid credentials.');
    await vpn.submit(value, engine);
  });
  handle('settings', value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
    if (value.launchAtLogin && !app.isPackaged) throw new Error('Install the packaged DropoVPN app before enabling Open at login.');
    if ('launchAtLogin' in value && typeof value.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
    store.settings(value);
  });
  handle('engine-check', async () => { engine = await detectEngine(store.data.settings.enginePath); return engine; });
  handle('engine-select', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Select the OpenVPN executable', properties: ['openFile'] });
    if (result.canceled) return;
    const found = await detectEngine(result.filePaths[0]);
    if (!found.available) throw new Error('Select an OpenVPN 2.6 or newer executable named openvpn or openvpn.exe.');
    store.data.settings.enginePath = found.path; store.persist(); engine = found;
  });
  handle('help', () => shell.openExternal('https://dropovpn.vercel.app/#setup'));
  handle('clear-logs', () => { vpn.logs = []; });
  await window.loadURL(uiURL); publish();
  importsReady = true; await flushProfileFiles();
  powerMonitor.on('resume', () => vpn.resume());
  app.on('activate', () => window.show());
}

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  Promise.resolve(vpn?.disconnect()).finally(() => { tray?.destroy(); app.quit(); });
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
