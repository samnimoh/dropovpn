import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Two isolated DropoVPN windows and a real relay process on loopback: create a
// mesh, share a local site, join from the second device, open the site there,
// then publish it as a public URL on the relay's domain. Nothing leaves this
// computer; the isolated sessions never broadcast on the network.
const free = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const get = (port, headers = {}) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, headers, agent: false }, response => { let body = ''; response.on('data', part => { body += part; }); response.on('end', () => resolve({ status: response.statusCode, body })); }).on('error', reject));
async function until(check, ms = 20000) { const start = Date.now(); for (;;) { const value = await check(); if (value) return value; if (Date.now() - start > ms) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } }

const site = http.createServer((request, response) => response.end(`Hello from device A (host ${request.headers.host})`));
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const sitePort = site.address().port, relayPort = await free(), token = randomBytes(18).toString('base64url');
const relay = spawn(process.execPath, ['relay/server.mjs'], { env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1', DROPO_RELAY_TOKEN: token, DROPO_PUBLIC_DOMAIN: 'localhost', DROPO_PUBLIC_SCHEME: 'http', DROPO_PUBLIC_PORT: String(relayPort) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(resolve => relay.stdout.once('data', resolve));

const directories = [], apps = [];
async function launch(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `dropovpn-mesh-${name}-`)); directories.push(directory);
  const env = { ...process.env, DROPOVPN_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.DROPOVPN_DEV;
  const app = await electron.launch({ args: ['.'], env }); apps.push(app);
  // Keep the invite out of the real clipboard.
  await app.evaluate(({ clipboard }) => { globalThis.copied = []; clipboard.writeText = text => { globalThis.copied.push(text); }; });
  const window = await app.firstWindow();
  const errors = []; window.on('pageerror', error => errors.push(error.message));
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  return { app, window, errors };
}
async function rename(window, name) {
  await window.getByRole('button', { name: 'Rename this device', exact: true }).click();
  await window.getByLabel('Device name', { exact: true }).fill(name);
  await window.getByRole('button', { name: 'Save name', exact: false }).click();
  await window.getByRole('heading', { name, exact: false }).waitFor();
}

try {
  const a = await launch('a'), b = await launch('b');
  fs.mkdirSync('test-results', { recursive: true });

  await a.window.getByRole('navigation').getByRole('button', { name: /^Device mesh/ }).click();
  await a.window.getByRole('heading', { name: 'Your devices, one network.', exact: true }).waitFor();
  await a.window.screenshot({ path: 'test-results/mesh-start.png' });
  await a.window.getByRole('button', { name: 'Create a mesh', exact: false }).click();
  await rename(a.window, 'Device A');
  await a.window.getByRole('button', { name: 'Set up', exact: false }).click();
  await a.window.getByLabel('Relay address', { exact: true }).fill(`ws://127.0.0.1:${relayPort}`);
  await a.window.getByLabel('Access token', { exact: true }).fill(token);
  await a.window.getByRole('button', { name: 'Save relay', exact: false }).click();
  await until(async () => (await a.window.evaluate(() => window.dropovpn.snapshot())).mesh.relay.status === 'connected');
  await a.window.getByLabel('Local address', { exact: true }).fill(`http://127.0.0.1:${sitePort}`);
  await a.window.getByLabel('Name Optional', { exact: true }).fill('Demo site');
  await a.window.getByRole('button', { name: 'Share', exact: true }).click();
  await a.window.getByRole('button', { name: 'Stop sharing Demo site', exact: true }).waitFor();
  await a.window.getByRole('button', { name: 'Copy invite', exact: false }).first().click();
  const invite = await until(() => a.app.evaluate(() => globalThis.copied.at(-1)));
  assert.match(invite, /^dropo1\./);
  assert.equal((await a.window.evaluate(() => JSON.stringify(window.dropovpn.snapshot()))).includes(invite.slice(7, 30)), false);

  await b.window.getByRole('navigation').getByRole('button', { name: /^Device mesh/ }).click();
  await b.window.getByRole('button', { name: 'Join with an invite', exact: false }).click();
  await b.window.getByLabel('Invite', { exact: true }).fill(invite);
  await b.window.getByRole('button', { name: 'Join mesh', exact: false }).click();
  await rename(b.window, 'Device B');

  // Device B gets the shared site on its own localhost, first through the relay.
  const peer = await until(async () => (await b.window.evaluate(() => window.dropovpn.snapshot())).mesh.peers.find(item => item.name === 'Device A' && item.services[0]?.localPort));
  const response = await get(peer.services[0].localPort);
  assert.equal(response.status, 200); assert.match(response.body, /^Hello from device A/);
  await b.window.getByText(`http://localhost:${peer.services[0].localPort}`, { exact: true }).waitFor();
  // Both sessions are on loopback, so the devices upgrade to a direct path.
  await until(async () => (await b.window.evaluate(() => window.dropovpn.snapshot())).mesh.peers[0].path === 'direct');
  await b.window.getByText('Direct', { exact: true }).waitFor();
  await b.window.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await b.app.evaluate(() => globalThis.copied.at(-1)), `http://localhost:${peer.services[0].localPort}`);
  await b.window.screenshot({ path: 'test-results/mesh-device-b.png', fullPage: true });
  await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await b.window.screenshot({ path: 'test-results/mesh-device-b-small.png' });
  await a.window.getByText('Device B', { exact: true }).waitFor();
  await a.window.screenshot({ path: 'test-results/mesh-device-a.png', fullPage: true });

  // A public URL on the relay's own domain.
  await a.window.getByRole('navigation').getByRole('button', { name: /^Public URLs/ }).click();
  await a.window.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('relay');
  await a.window.getByLabel('Local address', { exact: true }).fill(`127.0.0.1:${sitePort}`);
  await a.window.getByLabel('Name Optional', { exact: true }).fill('demo');
  await a.window.getByRole('button', { name: 'Create URL', exact: false }).click();
  const url = `http://demo.localhost:${relayPort}`;
  await a.window.getByText(url, { exact: true }).waitFor();
  const published = await get(relayPort, { host: `demo.localhost:${relayPort}` });
  assert.match(published.body, new RegExp(`^Hello from device A \\(host 127.0.0.1:${sitePort}\\)`));
  await a.window.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await a.app.evaluate(() => globalThis.copied.at(-1)), url);
  await until(() => a.window.getByRole('button', { name: 'Create URL', exact: false }).isEnabled());
  await a.window.screenshot({ path: 'test-results/public-urls.png', fullPage: true });
  await a.window.getByRole('button', { name: `Stop ${url}`, exact: true }).click();
  await a.window.getByRole('heading', { name: 'Nothing is public right now.', exact: true }).waitFor();
  assert.match((await get(relayPort, { host: `demo.localhost:${relayPort}` })).body, /not active/);

  // Leaving removes Device A from Device B's working set.
  await a.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await a.window.getByRole('navigation').getByRole('button', { name: /^Device mesh/ }).click();
  await a.window.getByRole('button', { name: 'Leave mesh', exact: true }).click();
  await a.window.getByRole('heading', { name: 'Your devices, one network.', exact: true }).waitFor();
  await until(async () => !(await b.window.evaluate(() => window.dropovpn.snapshot())).mesh.peers[0].online);
  await b.window.getByText('Offline', { exact: true }).waitFor();
  await assert.rejects(get(peer.services[0].localPort));
  assert.deepEqual([...a.errors, ...b.errors], []);
  console.log('Mesh smoke test passed: create, relay, share, invite, join, open on localhost, direct upgrade, public URL, leave.');
} finally {
  for (const app of apps) await app.close().catch(() => {});
  relay.kill(); site.close();
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
}
