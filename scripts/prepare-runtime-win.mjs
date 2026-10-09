import fs from 'node:fs';
import path from 'node:path';
import { root, download, run } from './runtime-downloads.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build/windows-runtime.json'), 'utf8'));
const installer = download(manifest);
const destination = path.join(root, 'vendor/win32-x64/openvpn');
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(installer, path.join(destination, 'OpenVPN.msi'));
fs.copyFileSync(path.join(root, 'build/windows-runtime.json'), path.join(destination, 'manifest.json'));
fs.copyFileSync(path.join(root, 'build/install-openvpn.ps1'), path.join(destination, 'install-openvpn.ps1'));
fs.copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), path.join(destination, 'THIRD-PARTY-NOTICES.txt'));
for (const file of ['openvpn-bundled-licenses.txt', 'openvpn-windows-license.txt']) fs.copyFileSync(path.join(root, 'build', file), path.join(destination, file));
if (process.platform === 'win32') {
  run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'build/install-openvpn.ps1'), '-RuntimeDirectory', destination, '-VerifyOnly']);
}
console.log(`Bundled official OpenVPN ${manifest.version} x64 setup, including signed network drivers.`);
