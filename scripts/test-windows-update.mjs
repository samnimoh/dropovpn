import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Updater } from '../electron/updater.mjs';

// Windows CI only, after the installer test: start the installed DropoVPN and
// run the in-app updater's real install step with this build's installer,
// exactly as "Restart to update" does. DropoVPN must quit, reinstall silently
// with administrator rights, and reopen.
const executable = path.join(process.env.ProgramFiles, 'DropoVPN', 'DropoVPN.exe');
const installer = path.resolve(process.argv[2] || path.join('release', fs.readdirSync('release').find(name => /^DropoVPN-.*-win-x64\.exe$/.test(name))));
const version = installer.match(/DropoVPN-(\d+\.\d+\.\d+)-win/)[1];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq DropoVPN.exe', '/FO', 'CSV', '/NH']).toString().split(/\r?\n/).map(line => line.split('","')[1]).filter(Boolean).map(Number);
async function until(check, ms, what) { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) { report(); throw new Error(`Timed out: ${what}`); } await pause(1000); } }
// What the install step recorded, and what was running, when something times out.
function report() {
  const log = path.join(path.dirname(installer), 'install.log');
  console.log('--- install.log'); console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(none)');
  console.log('--- processes'); console.log(execFileSync('tasklist', ['/FO', 'TABLE']).toString().split(/\r?\n/).filter(line => /DropoVPN|powershell|msiexec|Un_|Au_/i.test(line)).join('\n') || '(none)');
  console.log('--- install folder'); try { console.log(fs.readdirSync(path.dirname(executable)).join(', ')); } catch (error) { console.log(error.message); }
}

// The old version's uninstaller clears the install folder, so a marker left
// there disappears only if the update really reinstalled DropoVPN.
const marker = path.join(path.dirname(executable), 'update-test-marker.txt'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-update-'));
fs.writeFileSync(marker, 'remove me');
const app = spawn(executable, [`--user-data-dir=${data}`], { detached: true, stdio: 'ignore' }); app.unref();
await until(() => running().includes(app.pid), 30000, 'DropoVPN to start');
await pause(5000);
console.log(`DropoVPN ${version} is running as process ${app.pid}.`);

const updater = new Updater({ version, publicKey: '', directory: data, platform: 'win32', arch: 'x64', execPath: executable });
Object.assign(updater, { prepared: { version, file: installer } }); updater.state.status = 'ready';
if (!updater.install({ pid: app.pid })) throw new Error('The updater did not start the installer.');
console.log('Started the update installer; quitting DropoVPN as "Restart to update" does.');
process.kill(app.pid);

await until(() => !fs.existsSync(marker) && fs.existsSync(executable), 5 * 60 * 1000, 'the installer to replace DropoVPN');
console.log('DropoVPN was reinstalled.');
await until(() => running().some(pid => pid !== app.pid), 2 * 60 * 1000, 'DropoVPN to reopen');
console.log('DropoVPN reopened after the update.');
for (const required of [executable, path.join(process.env.ProgramFiles, 'OpenVPN', 'bin', 'openvpn.exe')]) if (!fs.existsSync(required)) throw new Error(`${required} is missing after the update.`);
execFileSync('taskkill', ['/IM', 'DropoVPN.exe', '/F']);
console.log('Windows in-app update test passed: quit, silent reinstall with administrator rights, reopen.');
