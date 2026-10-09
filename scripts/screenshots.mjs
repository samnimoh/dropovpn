import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture the real desktop UI in a separate, disposable user-data directory.
// Reserved example domains and synthetic certificates never create a tunnel.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-screenshots-'));
const env = { ...process.env, DROPOVPN_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DROPOVPN_DEV;
const app = await electron.launch({ args: ['.'], env });
try {
  const window = await app.firstWindow();
  await window.getByRole('heading', { name: 'Your connection.', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1160, 960));
  const profiles = [['Work network', 'vpn.example.com'], ['Home lab', 'home.example.com']];
  const files = profiles.map(([name, host]) => {
    const file = path.join(directory, `${name}.ovpn`);
    fs.writeFileSync(file, `client\ndev tun\nremote ${host} 1194\nauth-user-pass\n<ca>\nSYNTHETIC SCREENSHOT CERTIFICATE\n</ca>\n`);
    return file;
  });
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, files);
  await window.getByRole('button', { name: 'Import profile', exact: true }).first().click();
  await window.getByRole('button', { name: 'Work network vpn.example.com', exact: false }).waitFor();
  await window.evaluate(() => document.fonts.ready);
  fs.mkdirSync('website/assets/screenshots', { recursive: true });
  await window.screenshot({ path: 'website/assets/screenshots/connection.png' });
  await window.getByRole('button', { name: 'VPN profiles', exact: false }).click();
  await window.getByRole('heading', { name: 'Saved connections', exact: false }).waitFor();
  await window.screenshot({ path: 'website/assets/screenshots/profiles.png' });
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByRole('heading', { name: 'Make the connection yours', exact: true }).waitFor();
  await window.screenshot({ path: 'website/assets/screenshots/settings.png' });
  console.log('Captured three public screenshots using synthetic profiles; no VPN connection was attempted.');
} finally {
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
