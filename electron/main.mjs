import { app, BrowserWindow, ipcMain, dialog, safeStorage, Tray, Menu, nativeImage, powerMonitor, shell, clipboard } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { importProfile } from './profile.mjs';
import { detectEngine } from './launcher.mjs';
import { VPN } from './vpn.mjs';
import { MAX_SERVICES, MeshAgent, inUse, parseTarget } from './mesh.mjs';
import { createInvite, parseInvite, validateRelayToken, validateRelayURL } from './meshcrypto.mjs';
import { Tunnels } from './tunnels.mjs';
import { DEFAULT_RELAY } from './relay-defaults.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineOptions = { resourcesPath: app.isPackaged ? process.resourcesPath : path.join(here, '../vendor', `${process.platform}-${process.arch}`) };
const development = !app.isPackaged && process.env.DROPOVPN_DEV === '1';
const uiURL = development ? 'http://127.0.0.1:5173/' : new URL('../dist/index.html', import.meta.url).href;
app.setName('DropoVPN');
if (process.env.DROPOVPN_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.DROPOVPN_TEST_DATA);
// Isolated development sessions (smoke tests, screenshots) keep the mesh on
// loopback, never announce themselves, and never use the shared relay; the
// screenshot script points them at a local stand-in instead.
const isolated = !!process.env.DROPOVPN_TEST_DATA && !app.isPackaged;
const defaultRelay = !isolated ? DEFAULT_RELAY : process.env.DROPOVPN_TEST_RELAY ? { url: process.env.DROPOVPN_TEST_RELAY, token: process.env.DROPOVPN_TEST_RELAY_TOKEN || '' } : null;
let window, tray, store, vpn, engine, mesh = null, tunnels, quitting = false;
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
  return { profiles: store.list(), settings: store.data.settings, connection: { ...vpn.state }, logs: vpn.logs, engine, platform: process.platform, vaultAvailable: safeStorage.isEncryptionAvailable(), version: app.getVersion(), mesh: meshSnapshot(), tunnels: tunnels.snapshot() };
}
// The mesh key and relay token never leave the main process; the renderer
// sees configuration and live state only.
function meshSnapshot() {
  const config = store.data.mesh, live = mesh?.snapshot();
  return { configured: !!config.encryptedSecret, enabled: config.enabled, deviceName: config.deviceName || defaultDeviceName(), lanDiscovery: config.lanDiscovery, relayURL: config.relayURL, defaultRelayURL: defaultRelay?.url || '', hasRelayToken: !!config.encryptedRelayToken, services: config.services, port: live?.port ?? null, listenError: live?.listenError || '', relay: live?.relay || { status: 'off', message: '', publicTunnels: false }, peers: live?.peers || [] };
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
function shortId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) throw new Error('Invalid item.'); return value; }
function label(value, max, message) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(message);
  return value.trim();
}
const defaultDeviceName = () => os.hostname().replace(/\.local$/i, '').slice(0, 64) || 'This device';
const loopback = host => ['localhost', '127.0.0.1', '::1'].includes(host);

let meshWork = Promise.resolve();
function restartMesh() {
  // Serialize restarts so quick toggles never leave two agents bound.
  const work = async () => {
    tunnels.stopAll('relay');
    const previous = mesh; mesh = null; await previous?.stop();
    const config = store.data.mesh, secrets = config.enabled ? store.meshSecrets() : null;
    if (secrets) {
      mesh = new MeshAgent({ secret: secrets.secret, relayToken: secrets.relayToken, relayURL: config.relayURL, deviceId: config.deviceId, deviceName: config.deviceName || defaultDeviceName(), services: config.services, direct: config.lanDiscovery, lanDiscovery: config.lanDiscovery && !isolated, ...(isolated ? { host: '127.0.0.1', advertise: ['127.0.0.1'] } : {}), log: (message, level) => vpn.log(message, level) });
      mesh.on('change', publish);
      await mesh.start();
    }
    publish();
  };
  return (meshWork = meshWork.then(work, work));
}
// Links the renderer may open or copy: forwarded mesh addresses and active public URLs.
function knownLink(value, { open = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('That link is no longer active.');
  const local = value.match(open ? /^(https?):\/\/localhost:(\d+)\/?$/ : /^(?:(https?):\/\/)?localhost:(\d+)\/?$/);
  if (local && mesh?.forwardPorts().includes(Number(local[2]))) return value;
  if (tunnels.snapshot().list.some(tunnel => tunnel.url && tunnel.url === value)) return value;
  throw new Error('That link is no longer active.');
}
const COMMON_PORTS = [3000, 3001, 4000, 4200, 4321, 5173, 5174, 8000, 8080, 8081, 8787, 8888, 9000];
async function detectPorts() {
  const skip = new Set([...(mesh?.forwardPorts() || []), ...store.data.mesh.services.filter(service => loopback(service.host)).map(service => service.port)]);
  const found = await Promise.all(COMMON_PORTS.filter(port => !skip.has(port)).map(async port => (await inUse(port)) ? port : null));
  return found.filter(Boolean);
}

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
  store = new Store(app.getPath('userData'), safeStorage); engine = await detectEngine(store.data.settings.enginePath, engineOptions);
  vpn = new VPN({ store }); vpn.on('change', publish);
  tunnels = new Tunnels({ getMesh: () => mesh, log: (message, level) => vpn.log(message, level) }); tunnels.on('change', publish);
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
  handle('connect', async value => { id(value); engine = await detectEngine(store.data.settings.enginePath, engineOptions); await vpn.connect(value, null, engine); });
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
  handle('engine-check', async () => { engine = await detectEngine(store.data.settings.enginePath, engineOptions); return engine; });
  handle('engine-select', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Select the OpenVPN executable', properties: ['openFile'] });
    if (result.canceled) return;
    const found = await detectEngine(result.filePaths[0], engineOptions);
    if (!found.available) throw new Error('Select an OpenVPN 2.6 or newer executable named openvpn or openvpn.exe.');
    store.data.settings.enginePath = found.path; store.persist(); engine = found;
  });
  handle('help', () => shell.openExternal('https://dropovpn.vercel.app/#setup'));
  handle('mesh-create', async () => {
    if (store.data.mesh.encryptedSecret) throw new Error('This device is already in a mesh.');
    // New meshes start on the shared relay, so devices on different networks connect at once.
    store.saveMesh({ secret: randomBytes(32), relayToken: defaultRelay?.token || '', relayURL: defaultRelay?.url || '', enabled: true });
    vpn.log('Created a new device mesh.'); await restartMesh();
  });
  handle('mesh-join', async invite => {
    const { secret, relayURL, relayToken } = parseInvite(invite);
    if (store.data.mesh.encryptedSecret) throw new Error('Leave your current mesh before joining another.');
    store.saveMesh({ secret, relayURL, relayToken, enabled: true });
    vpn.log('Joined a device mesh.'); await restartMesh();
  });
  handle('mesh-leave', async () => {
    const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Leave mesh'], defaultId: 0, cancelId: 0, message: 'Leave this device mesh?', detail: 'Your other devices will lose access to what this device shares, and this device will lose access to theirs. Public URLs on your relay stop too. To come back, join again with an invite.' });
    if (answer.response !== 1) return;
    store.saveMesh({ secret: null, relayToken: '', relayURL: '', enabled: false, services: [] });
    await restartMesh(); vpn.log('Left the device mesh.');
  });
  handle('mesh-invite', () => {
    const secrets = store.meshSecrets();
    if (!secrets) throw new Error('Create or join a mesh first.');
    clipboard.writeText(createInvite({ secret: secrets.secret, relayURL: store.data.mesh.relayURL, relayToken: secrets.relayToken }));
  });
  handle('mesh-settings', async value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
    const patch = {};
    if ('deviceName' in value) patch.deviceName = label(value.deviceName, 64, 'Enter a device name between 1 and 64 characters.') || defaultDeviceName();
    for (const key of ['enabled', 'lanDiscovery']) if (key in value) { if (typeof value[key] !== 'boolean') throw new Error('Invalid setting.'); patch[key] = value[key]; }
    if ('relayURL' in value) {
      patch.relayURL = validateRelayURL(value.relayURL);
      const token = validateRelayToken(value.relayToken || '');
      // An empty token field keeps the saved token for the same relay only, so a
      // token is never sent to a different host. Clearing the address removes both.
      const sameHost = !!store.data.mesh.relayURL && !!patch.relayURL && new URL(store.data.mesh.relayURL).host === new URL(patch.relayURL).host;
      if (!patch.relayURL) patch.relayToken = ''; else if (token) patch.relayToken = token;
      else if (defaultRelay && patch.relayURL === defaultRelay.url) patch.relayToken = defaultRelay.token;
      else if (!store.data.mesh.encryptedRelayToken || !sameHost) throw new Error('Enter the access token for this relay.');
    }
    if (!store.data.mesh.encryptedSecret) throw new Error('Create or join a mesh first.');
    store.saveMesh(patch);
    if (Object.keys(patch).some(key => key !== 'deviceName')) await restartMesh(); else mesh?.update({ deviceName: store.data.mesh.deviceName });
  });
  handle('mesh-share', value => {
    const services = store.data.mesh.services;
    if (!store.data.mesh.encryptedSecret) throw new Error('Create or join a mesh first.');
    if (!value || typeof value !== 'object') throw new Error('Invalid address.');
    const target = parseTarget(value.target), name = label(value.name, 64, 'Enter a name up to 64 characters.');
    if (services.length >= MAX_SERVICES) throw new Error(`You can share up to ${MAX_SERVICES} addresses.`);
    if (services.some(service => service.host === target.host && service.port === target.port)) throw new Error('This address is already shared.');
    // Sharing a forwarded port would send other devices back to themselves.
    if (loopback(target.host) && mesh?.forwardPorts().includes(target.port)) throw new Error('That port opens another device’s address. Share it from that device instead.');
    const service = { id: randomBytes(8).toString('hex'), name: name || `Port ${target.port}`, host: target.host, port: target.port, protocol: target.protocol };
    store.saveMesh({ services: [...services, service] }); mesh?.update({ services: store.data.mesh.services });
    vpn.log(`Sharing ${service.name} (${target.address}) with your mesh.`);
  });
  handle('mesh-unshare', value => {
    shortId(value);
    store.saveMesh({ services: store.data.mesh.services.filter(service => service.id !== value) }); mesh?.update({ services: store.data.mesh.services });
  });
  handle('mesh-detect', () => detectPorts());
  handle('tunnel-start', value => {
    if (!value || typeof value !== 'object' || typeof value.provider !== 'string' || typeof value.target !== 'string') throw new Error('Invalid public URL.');
    return tunnels.start({ provider: value.provider, target: value.target, name: value.name ?? '' });
  });
  handle('tunnel-stop', value => tunnels.stop(shortId(value)));
  handle('tunnel-tools', () => tunnels.refresh());
  handle('open-link', value => shell.openExternal(knownLink(value, { open: true })));
  handle('copy-link', value => clipboard.writeText(knownLink(value)));
  handle('clear-logs', () => { vpn.logs = []; });
  await window.loadURL(uiURL); publish();
  void restartMesh().catch(error => vpn.log(`Device mesh could not start: ${error.message}`, 'error'));
  void tunnels.refresh();
  importsReady = true; await flushProfileFiles();
  powerMonitor.on('resume', () => vpn.resume());
  app.on('activate', () => window.show());
}

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  tunnels?.stopAll();
  Promise.allSettled([vpn?.disconnect(), mesh?.stop()]).finally(() => { tray?.destroy(); app.quit(); });
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
