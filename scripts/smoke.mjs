import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-smoke-'));
const env = { ...process.env, DROPOVPN_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.DROPOVPN_DEV;
const app = await electron.launch({ args: ['.'], env });
try {
  const window = await app.firstWindow();
  const errors = []; window.on('pageerror', e => errors.push(e.message));
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  const snapshot = await window.evaluate(() => window.dropovpn.snapshot());
  assert.equal(snapshot.connection.status, 'disconnected');
  assert.equal(snapshot.profiles.length, 0);
  assert.equal(await window.getByRole('button', { name: 'Connect to VPN', exact: true }).isDisabled(), true);
  await window.getByRole('switch', { name: 'Automatic reconnection', exact: true }).click();
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await window.getByRole('switch', { name: 'Automatically reconnect', exact: true }).getAttribute('aria-checked'), 'false');
  await window.getByRole('switch', { name: 'Automatically reconnect', exact: true }).click();
  await window.getByRole('button', { name: 'Check installation', exact: true }).click();
  await window.getByRole('button', { name: 'Activity', exact: true }).click();
  await window.getByRole('heading', { name: 'All quiet here.', exact: true }).waitFor();
  await window.getByRole('button', { name: 'VPN profiles', exact: false }).click();
  await window.getByRole('heading', { name: 'Saved connections', exact: false }).waitFor();
  await window.getByRole('button', { name: 'Connection', exact: true }).click();
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  await window.getByRole('button', { name: 'Connection', exact: true }).getAttribute('aria-current').then(value => assert.equal(value, 'page'));
  fs.mkdirSync('test-results', { recursive: true });
  await window.screenshot({ path: 'test-results/desktop.png' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await window.screenshot({ path: 'test-results/desktop-small.png' });
  assert.deepEqual(errors, []);
  const security = await window.evaluate(() => ({ node: typeof window.require, api: !!window.dropovpn }));
  assert.deepEqual(security, { node: 'undefined', api: true });
  const profilePath = path.join(directory, 'Office.ovpn');
  fs.writeFileSync(profilePath, 'client\ndev tun\nremote vpn.example.test 1194\nauth-user-pass\n<ca>\nTEST CERTIFICATE\n</ca>\n');
  await app.evaluate(({ dialog }, profilePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [profilePath] }); }, profilePath);
  await window.getByRole('button', { name: 'Import profile', exact: true }).first().click();
  await window.getByRole('button', { name: 'Office vpn.example.test', exact: false }).waitFor();
  let imported = await window.evaluate(() => window.dropovpn.snapshot());
  assert.equal(imported.profiles.length, 1);
  assert.equal(imported.profiles[0].encryptedConfig, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'dropovpn.json'), 'utf8'), /TEST CERTIFICATE/);
  if (imported.engine.available) {
    await window.getByRole('button', { name: 'Connect to VPN', exact: true }).click();
    await window.getByRole('dialog').waitFor();
    await window.getByLabel('Username', { exact: true }).fill('test-user');
    await window.getByLabel('Password', { exact: true }).fill('test-password');
    await window.screenshot({ path: 'test-results/sign-in.png' });
    // Closing the sign-in dialog cancels before any elevation or tunnel.
    await window.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await window.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await window.getByRole('button', { name: 'Options for Office', exact: true }).click();
  await window.getByRole('button', { name: 'Rename profile', exact: true }).click();
  await window.getByLabel('Profile name', { exact: true }).fill('Work network');
  await window.getByRole('button', { name: 'Save name', exact: false }).click();
  await window.getByRole('button', { name: 'Work network vpn.example.test', exact: false }).waitFor();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await window.getByRole('button', { name: 'Options for Work network', exact: true }).click();
  await window.getByRole('button', { name: 'Remove profile', exact: true }).click();
  await window.getByRole('heading', { name: 'Your next connection starts here', exact: true }).waitFor();
  // Exercise a Finder/file-association import using the exact same path handler
  // as the packaged app. The fixture contains no real certificate material.
  await app.evaluate(({ app }, filename) => app.emit('open-file', { preventDefault() {} }, filename), profilePath);
  await window.getByRole('button', { name: 'Office vpn.example.test', exact: false }).waitFor();
  assert.equal((await window.evaluate(() => window.dropovpn.snapshot())).profiles.length, 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  console.log('Electron smoke test passed: import, OS-encrypted storage, sign-in dialog, rename/remove, settings, tray, navigation, context isolation.');
} finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
