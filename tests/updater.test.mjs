import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { MAC_INSTALLER, Updater, bundleOf, compareVersions, pickRelease, verifiedChecksums } from '../electron/updater.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
const sha = data => createHash('sha256').update(data).digest('hex');
const temporary = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-update-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
async function until(predicate, ms = 5000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(resolve => setTimeout(resolve, 10)); } }

// A stand-in for GitHub: a release list and the files it links to.
async function feed(t, { files, signer = keys.privateKey, extra = [], tamper = false } = {}) {
  const assets = new Map(Object.entries(files));
  const sums = [...assets].map(([name, data]) => `${sha(data)}  ${name}`).join('\n') + '\n';
  assets.set('SHA256SUMS.txt', Buffer.from(sums));
  assets.set('SHA256SUMS.txt.sig', Buffer.from(sign(null, Buffer.from(sums), signer).toString('base64')));
  if (tamper) for (const [name, data] of assets) if (!name.startsWith('SHA256SUMS')) assets.set(name, Buffer.concat([data, Buffer.from('!')]));
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url.startsWith('/releases')) {
      const link = name => ({ name, browser_download_url: `http://127.0.0.1:${port}/download/${name}` });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([...extra, { tag_name: 'v0.4.1', draft: false, prerelease: true, html_url: 'https://github.com/samnimoh/dropovpn/releases/tag/v0.4.1', assets: [...assets.keys()].map(link) }]));
      return;
    }
    const data = assets.get(decodeURIComponent(request.url.replace('/download/', '')));
    if (!data) { response.writeHead(404).end(); return; }
    response.setHeader('content-length', data.length); response.end(data);
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/releases`;
}

test('compares versions and picks only newer releases with signed checksums for this platform', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1); assert.equal(compareVersions('v1.2.3', '1.2.3'), 0); assert.equal(compareVersions('0.3.1', '0.4.0'), -1);
  const asset = name => ({ name, browser_download_url: `https://github.com/x/${name}` });
  const signed = version => ({ tag_name: `v${version}`, assets: [asset(`DropoVPN-${version}-win-x64.exe`), asset(`DropoVPN-${version}-mac-arm64.zip`), asset('SHA256SUMS.txt'), asset('SHA256SUMS.txt.sig')] });
  const releases = [signed('0.4.1'), { ...signed('0.6.0'), draft: true }, { ...signed('0.5.0'), assets: signed('0.5.0').assets.slice(0, 3) }, signed('0.3.0'), { tag_name: 'nightly' }, signed('0.4.3')];
  assert.equal(pickRelease(releases, '0.4.0', 'win32', 'x64').version, '0.4.3');
  assert.equal(pickRelease(releases, '0.4.0', 'darwin', 'arm64').asset.name, 'DropoVPN-0.4.3-mac-arm64.zip');
  assert.equal(pickRelease(releases, '0.4.3', 'win32', 'x64'), null);
  assert.equal(pickRelease(releases, '0.4.0', 'linux', 'x64'), null);
  assert.equal(pickRelease('not a list', '0.4.0', 'win32', 'x64'), null);
});

test('checksums count only with a valid signature from the built-in key', () => {
  const text = `${'a'.repeat(64)}  DropoVPN-0.4.1-win-x64.exe\n`;
  const good = sign(null, Buffer.from(text), keys.privateKey).toString('base64');
  assert.equal(verifiedChecksums(text, good, publicKey).get('DropoVPN-0.4.1-win-x64.exe'), 'a'.repeat(64));
  assert.throws(() => verifiedChecksums(text.replace('a', 'b'), good, publicKey), /signature is not valid/);
  const stranger = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => verifiedChecksums(text, sign(null, Buffer.from(text), stranger).toString('base64'), publicKey), /signature is not valid/);
  assert.throws(() => verifiedChecksums(text, 'not base64 at all', publicKey), /signature is not valid/);
});

test('downloads, verifies and installs a Windows update after asking', async t => {
  const installer = randomBytes(300 * 1024), directory = temporary(t), spawned = [];
  const url = await feed(t, { files: { 'DropoVPN-0.4.1-win-x64.exe': installer }, extra: [{ tag_name: 'v0.5.0', assets: [] }] });
  const spawnProcess = (command, args, options) => { spawned.push({ command, args, options }); return { unref() {} }; };
  const updater = new Updater({ version: '0.4.0', publicKey, directory, feed: url, platform: 'win32', arch: 'x64', execPath: 'C:\\Program Files\\DropoVPN\\DropoVPN.exe', spawnProcess });
  const progress = []; updater.on('change', () => progress.push(updater.state.progress));
  await updater.check({ manual: true });
  assert.equal(updater.state.status, 'available'); assert.equal(updater.state.version, '0.4.1'); assert.equal(updater.state.manual, false);
  assert.throws(() => updater.install(), /Download the update first/);
  await updater.download();
  assert.equal(updater.state.status, 'ready', updater.state.message);
  assert.ok(progress.some(value => value > 0 && value < 1), 'progress was reported');
  assert.equal(sha(fs.readFileSync(updater.prepared.file)), sha(installer));
  assert.equal(updater.install({ pid: 4242 }), true);
  assert.equal(updater.state.status, 'installing');
  assert.match(spawned[0].command, /powershell\.exe$/); assert.equal(spawned[0].options.detached, true);
  const script = Buffer.from(spawned[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Wait-Process -Id 4242/); assert.match(script, /-Verb RunAs -Wait/);
  assert.ok(script.includes(`'${path.join(path.dirname(updater.prepared.file), 'install.log')}'`));
  assert.ok(script.includes(`'${updater.prepared.file}'`)); assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\DropoVPN\\DropoVPN.exe'/);
});

test('discards a download that does not match its signed checksum', async t => {
  const directory = temporary(t);
  const url = await feed(t, { files: { 'DropoVPN-0.4.1-win-x64.exe': randomBytes(1000) }, tamper: true });
  const updater = new Updater({ version: '0.4.0', publicKey, directory, feed: url, platform: 'win32', arch: 'x64' });
  await updater.check(); await updater.download();
  assert.equal(updater.state.status, 'error'); assert.match(updater.state.message, /did not match its signed checksum/);
  assert.equal(fs.existsSync(path.join(directory, '0.4.1')), false);
});

test('refuses releases signed with a different key and insecure update addresses', async t => {
  const url = await feed(t, { files: { 'DropoVPN-0.4.1-win-x64.exe': randomBytes(1000) }, signer: generateKeyPairSync('ed25519').privateKey });
  const updater = new Updater({ version: '0.4.0', publicKey, directory: temporary(t), feed: url, platform: 'win32', arch: 'x64' });
  await updater.check(); await updater.download();
  assert.match(updater.state.message, /signature is not valid/);
  const remote = new Updater({ version: '0.4.0', publicKey, directory: temporary(t), feed: 'http://example.com/releases', platform: 'win32', arch: 'x64' });
  await remote.check({ manual: true });
  assert.equal(remote.state.status, 'error'); assert.match(remote.state.message, /not allowed/);
  const current = new Updater({ version: '0.4.1', publicKey, directory: temporary(t), feed: url, platform: 'win32', arch: 'x64' });
  await current.check({ manual: true });
  assert.equal(current.state.status, 'current');
});

test('knows when a Mac app cannot be replaced in place', () => {
  assert.equal(bundleOf('/private/var/folders/x/AppTranslocation/ABC/d/DropoVPN.app/Contents/MacOS/DropoVPN', 'darwin').writable, false);
  assert.equal(bundleOf('/Volumes/DropoVPN 0.4.0/DropoVPN.app/Contents/MacOS/DropoVPN', 'darwin').writable, false);
  assert.equal(bundleOf('C:\\Program Files\\DropoVPN\\DropoVPN.exe', 'win32'), null);
});

// Real bundles, signatures, archives and the real swap script, on macOS only.
const mac = process.platform === 'darwin' ? test : test.skip;
function fakeApp(directory, version) {
  const app = path.join(directory, 'DropoVPN.app'), contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(contents, 'MacOS', 'DropoVPN'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.dropovpn.desktop</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>DropoVPN</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return app;
}
function opener(directory) {
  const log = path.join(directory, 'opened.log'), script = path.join(directory, 'open.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  return { script, opened: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

mac('updates a Mac app in place: verify, swap, and reopen', async t => {
  const directory = temporary(t), build = path.join(directory, 'build'), installed = path.join(directory, 'Applications');
  fs.mkdirSync(build); fs.mkdirSync(installed);
  const next = fakeApp(build, '0.4.1'), zip = path.join(directory, 'update.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, zip]);
  const current = fakeApp(installed, '0.4.0');
  const url = await feed(t, { files: { 'DropoVPN-0.4.1-mac-arm64.zip': fs.readFileSync(zip) } });
  const spawned = [];
  const updater = new Updater({ version: '0.4.0', publicKey, directory: path.join(directory, 'Updates'), feed: url, platform: 'darwin', arch: 'arm64', execPath: path.join(current, 'Contents', 'MacOS', 'DropoVPN'), spawnProcess: (command, args) => { spawned.push({ command, args }); return { unref() {} }; } });
  await updater.check(); await updater.download();
  assert.equal(updater.state.status, 'ready', updater.state.message);
  assert.equal(updater.install({ pid: 999999 }), true);
  const [script, pid, bundle, app] = spawned[0].args;
  assert.equal(spawned[0].command, '/bin/sh'); assert.equal(pid, '999999'); assert.equal(bundle, current); assert.equal(app, updater.prepared.app);
  // Run the real installer script, with Finder's "open" recorded instead.
  const open = opener(directory);
  const result = spawnSync('/bin/sh', [script, '999999', bundle, app, open.script]);
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(current, 'Contents', 'Info.plist')]).toString().trim(), '0.4.1');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', current]);
  assert.deepEqual(open.opened(), [current]);
  assert.equal(fs.existsSync(`${app}.previous`), false);
});

mac('a Mac swap that is not allowed keeps the old app and shows the new one', t => {
  const directory = temporary(t), installed = path.join(directory, 'Applications'), staged = path.join(directory, 'staged');
  fs.mkdirSync(installed); fs.mkdirSync(staged);
  const current = fakeApp(installed, '0.4.0'), next = fakeApp(staged, '0.4.1'), script = path.join(directory, 'install.sh'), open = opener(directory);
  fs.writeFileSync(script, MAC_INSTALLER, { mode: 0o700 });
  fs.chmodSync(installed, 0o555);
  const result = spawnSync('/bin/sh', [script, '999999', current, next, open.script]);
  fs.chmodSync(installed, 0o755);
  assert.equal(result.status, 1);
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(current, 'Contents', 'Info.plist')]).toString().trim(), '0.4.0');
  assert.deepEqual(open.opened(), [`-R ${next}`, current]);
});
