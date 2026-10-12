import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Capture the real desktop UI in separate, disposable user-data directories.
// Reserved example domains and synthetic certificates never create a tunnel.
// The mesh runs on loopback through a local relay, and a stand-in cloudflared
// prints an example address, so no device or URL is exposed. macOS or Linux.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-screenshots-'));
const output = 'website/assets/screenshots';
const free = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
async function until(check, ms = 20000) { const start = Date.now(); for (;;) { const value = await check(); if (value) return value; if (Date.now() - start > ms) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } }

const bin = path.join(temporary, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2025.9.1 (built 2025-09-22)"; exit 0; fi
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://quiet-river-studio.trycloudflare.com  |" >&2
exec sleep 600
`, { mode: 0o755 });
const relayPort = await free(), token = randomBytes(18).toString('base64url');
const relay = spawn(process.execPath, ['relay/server.mjs'], { env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1', DROPO_RELAY_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(resolve => relay.stdout.once('data', resolve));

const apps = [];
async function launch(name) {
  const directory = path.join(temporary, name); fs.mkdirSync(directory);
  const env = { ...process.env, DROPOVPN_TEST_DATA: directory, DROPOVPN_TEST_RELAY: `ws://127.0.0.1:${relayPort}/`, DROPOVPN_TEST_RELAY_TOKEN: token, PATH: `${bin}:${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DROPOVPN_DEV;
  // Crisp 2x images whichever display this runs on.
  const app = await electron.launch({ args: ['--force-device-scale-factor=2', '.'], env }); apps.push(app);
  await app.evaluate(({ clipboard }) => { globalThis.copied = []; clipboard.writeText = text => { globalThis.copied.push(text); }; });
  const window = await app.firstWindow();
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  return { app, window, mesh: async () => (await window.evaluate(() => window.dropovpn.snapshot())).mesh };
}
// Let hover and navigation highlight transitions finish before capturing.
const capture = async (window, name) => { await window.mouse.move(0, 0); await new Promise(resolve => setTimeout(resolve, 400)); await window.screenshot({ path: `${output}/${name}.png` }); };
const nav = (window, name) => window.getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).click();
async function rename(window, name) {
  await window.getByRole('button', { name: 'Rename this device', exact: true }).click();
  await window.getByLabel('Device name', { exact: true }).fill(name);
  await window.getByRole('button', { name: 'Save name', exact: false }).click();
  await window.getByRole('heading', { name, exact: false }).waitFor();
}
async function share(window, address, name) {
  await window.getByLabel('Local address', { exact: true }).fill(address);
  await window.getByLabel('Name Optional', { exact: true }).fill(name);
  await window.getByRole('button', { name: 'Share', exact: true }).click();
  await window.getByRole('button', { name: `Stop sharing ${name}`, exact: true }).waitFor();
}
async function join(device, invite, name) {
  await nav(device.window, 'Device mesh');
  await device.window.getByRole('button', { name: 'Join with an invite', exact: false }).click();
  await device.window.getByLabel('Invite', { exact: true }).fill(invite);
  await device.window.getByRole('button', { name: 'Join mesh', exact: false }).click();
  await rename(device.window, name);
}

try {
  const studio = await launch('studio'), { app, window } = studio;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1160, 878));
  const profiles = [['Work network', 'vpn.example.com'], ['Home lab', 'home.example.com']];
  const files = profiles.map(([name, host]) => {
    const file = path.join(temporary, `${name}.ovpn`);
    fs.writeFileSync(file, `client\ndev tun\nremote ${host} 1194\nauth-user-pass\n<ca>\nSYNTHETIC SCREENSHOT CERTIFICATE\n</ca>\n`);
    return file;
  });
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, files);
  await window.getByRole('button', { name: 'Import profile', exact: true }).first().click();
  await window.getByRole('button', { name: 'Work network vpn.example.com', exact: false }).waitFor();

  // A mesh: this Mac shares a web app, a laptop shares two, and a desktop is offline.
  await nav(window, 'Device mesh');
  await window.getByRole('button', { name: 'Create a mesh', exact: false }).click();
  await rename(window, 'Studio MacBook');
  await share(window, 'localhost:5173', 'Web app');
  await window.getByRole('button', { name: 'Copy invite', exact: false }).first().click();
  const invite = await until(() => app.evaluate(() => globalThis.copied.at(-1)));
  const laptop = await launch('laptop'), office = await launch('office');
  await join(laptop, invite, 'Travel laptop'); await join(office, invite, 'Office desktop');
  await until(async () => (await studio.mesh()).peers.filter(peer => peer.online).length === 2);
  await office.window.getByRole('switch', { name: 'Device mesh on this device', exact: true }).click();
  await until(async () => (await studio.mesh()).peers.some(peer => peer.name === 'Office desktop' && !peer.online));
  await share(laptop.window, 'localhost:6006', 'Storybook'); await share(laptop.window, 'http://localhost:8000', 'API');
  await until(async () => { const peer = (await studio.mesh()).peers.find(item => item.name === 'Travel laptop'); return peer?.path === 'direct' && peer.services.length === 2 && peer.services.every(service => service.localPort); });

  await nav(window, 'Connection');
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  await window.evaluate(() => document.fonts.ready);
  fs.mkdirSync(output, { recursive: true });
  await capture(window, 'connection');
  await nav(window, 'VPN profiles');
  await window.getByRole('heading', { name: 'Saved connections', exact: false }).waitFor();
  await capture(window, 'profiles');
  await nav(window, 'Device mesh');
  await window.getByText('localhost:6006', { exact: false }).waitFor();
  await capture(window, 'mesh');
  await nav(window, 'Public URLs');
  await window.getByLabel('Local address', { exact: true }).fill('localhost:5173');
  await window.getByRole('button', { name: 'Create URL', exact: false }).click();
  await window.getByText('https://quiet-river-studio.trycloudflare.com', { exact: true }).waitFor();
  await capture(window, 'public-urls');
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByRole('heading', { name: 'Make the connection yours', exact: true }).waitFor();
  await capture(window, 'settings');
  console.log('Captured five screenshots with synthetic profiles, a loopback mesh and a stand-in cloudflared; no VPN, relay or public URL was used.');
} finally {
  for (const app of apps) await app.close().catch(() => {});
  relay.kill();
  fs.rmSync(temporary, { recursive: true, force: true });
}
