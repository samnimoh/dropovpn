import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const FEED = 'https://api.github.com/repos/samnimoh/dropovpn/releases?per_page=20';
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";

export function compareVersions(a, b) {
  const [x, y] = [a, b].map(value => value.match(VERSION).slice(1).map(Number));
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index] ? 1 : -1;
  return 0;
}

// The newest release that is newer than this version, built for this
// platform, and published with signed checksums. Older unsigned releases are
// never offered.
export function pickRelease(releases, current, platform, arch) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = typeof release?.tag_name === 'string' && !release.draft && VERSION.test(release.tag_name) ? release.tag_name.replace(/^v/, '') : null;
    if (!version || compareVersions(version, current) <= 0 || (best && compareVersions(version, best.version) <= 0)) continue;
    const url = name => (Array.isArray(release.assets) ? release.assets : []).find(asset => asset?.name === name)?.browser_download_url;
    const name = platform === 'darwin' ? `DropoVPN-${version}-mac-${arch}.zip` : platform === 'win32' ? `DropoVPN-${version}-win-${arch}.exe` : null;
    if (!name || !url(name) || !url('SHA256SUMS.txt') || !url('SHA256SUMS.txt.sig')) continue;
    best = { version, notes: typeof release.html_url === 'string' ? release.html_url : null, asset: { name, url: url(name) }, sums: url('SHA256SUMS.txt'), signature: url('SHA256SUMS.txt.sig') };
  }
  return best;
}

// Checksums are trusted only with a valid Ed25519 signature from the key
// built into the app, so a tampered release cannot pass as an update.
export function verifiedChecksums(text, signature, publicKey) {
  const valid = (() => { try { return verify(null, Buffer.from(text), createPublicKey(publicKey), Buffer.from(String(signature).trim(), 'base64')); } catch { return false; } })();
  if (!valid) throw new Error('The update’s signature is not valid, so it was not installed.');
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) { const match = line.match(/^([a-f0-9]{64})\s+\*?(\S+)$/); if (match) sums.set(match[2], match[1]); }
  return sums;
}

// Where the running app lives, and whether it can be replaced in place. An
// app opened from its disk image or still in quarantine runs from a read-only
// copy, so it can only be updated by hand.
export function bundleOf(execPath, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const bundle = path.resolve(execPath, '../../..');
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return { path: bundle, writable: false };
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); return { path: bundle, writable: true }; }
  catch { return { path: bundle, writable: false }; }
}

// Replace the app once it has quit and reopen it. If anything fails, the
// previous version goes back in place, reopens, and Finder shows the new
// version so it can be dragged into place by hand.
export const MAC_INSTALLER = `#!/bin/sh
pid="$1"; current="$2"; next="$3"; opener="\${4:-/usr/bin/open}"
i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 0.5; i=$((i + 1)); done
previous="$next.previous"
/bin/rm -rf "$previous"
if /bin/mv "$current" "$previous" 2>/dev/null; then
  if /bin/mv "$next" "$current"; then /bin/rm -rf "$previous"; "$opener" "$current"; exit 0; fi
  /bin/mv "$previous" "$current"
fi
"$opener" -R "$next"
"$opener" "$current"
exit 1
`;

export function windowsInstaller({ pid, installer, executable, log }) {
  // Wait for DropoVPN to quit, run the installer with administrator approval,
  // then reopen DropoVPN whether or not the update was approved. Each step is
  // logged beside the installer, so a failed update can say what happened.
  return `$ErrorActionPreference='Continue'
function Note($text) { Add-Content -LiteralPath ${psQuote(log)} -Value ((Get-Date).ToString('s') + ' ' + $text) }
Note 'Waiting for DropoVPN to quit.'
Wait-Process -Id ${Number(pid)} -Timeout 60 -ErrorAction SilentlyContinue
Note 'Starting the installer.'
try { $setup = Start-Process -FilePath ${psQuote(installer)} -ArgumentList @('/S','--updated') -Verb RunAs -Wait -PassThru -ErrorAction Stop; Note ('Installer finished with exit code ' + $setup.ExitCode + '.') }
catch { Note ('Installer did not run: ' + $_.Exception.Message) }
Note 'Reopening DropoVPN.'
Start-Process -FilePath ${psQuote(executable)}`;
}

export class Updater extends EventEmitter {
  constructor({ version, publicKey, directory, feed = FEED, platform = process.platform, arch = process.arch, execPath = process.execPath, fetch = globalThis.fetch, spawnProcess = spawn, log = () => {} }) {
    super(); Object.assign(this, { version, publicKey, directory, feed, platform, arch, execPath, fetchFn: fetch, spawnProcess, log });
    // Plain HTTP is accepted only from this computer, for tests.
    this.insecure = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(feed);
    this.state = { status: 'idle', current: version, version: null, notes: null, progress: 0, message: '', checkedAt: null, manual: false };
    this.release = null; this.prepared = null; this.busy = null;
  }
  update(patch) { Object.assign(this.state, patch); this.emit('change'); }
  allowed(url) {
    let parsed; try { parsed = new URL(url); } catch { return false; }
    return parsed.protocol === 'https:' || (this.insecure && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname));
  }
  async request(url, { accept = 'application/octet-stream', timeout = 30000 } = {}) {
    if (!this.allowed(url)) throw new Error('The update address is not allowed.');
    const response = await this.fetchFn(url, { redirect: 'follow', headers: { Accept: accept, 'User-Agent': `DropoVPN/${this.version}` }, signal: AbortSignal.timeout(timeout) });
    if (!this.allowed(response.url || url)) throw new Error('The update address is not allowed.');
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is limiting update checks. Try again later.' : `GitHub answered with HTTP ${response.status}.`);
    return response;
  }
  async text(url, limit) {
    const text = await (await this.request(url)).text();
    if (text.length > limit) throw new Error('An update file was larger than expected.');
    return text;
  }
  check({ manual = false } = {}) {
    if (this.busy) return this.busy;
    if (['downloading', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.state);
    this.update({ status: 'checking', message: '' });
    this.busy = (async () => {
      try {
        const releases = await (await this.request(this.feed, { accept: 'application/vnd.github+json' })).json();
        const release = pickRelease(releases, this.version, this.platform, this.arch);
        this.release = release;
        if (!release) { this.update({ status: 'current', version: null, notes: null, checkedAt: new Date().toISOString() }); return this.state; }
        const bundle = bundleOf(this.execPath, this.platform);
        this.update({ status: 'available', version: release.version, notes: release.notes, progress: 0, checkedAt: new Date().toISOString(), manual: !!bundle && !bundle.writable });
        if (!manual) this.log(`DropoVPN ${release.version} is available.`);
      } catch (error) {
        this.update({ status: manual ? 'error' : 'idle', message: manual ? `Couldn’t check for updates: ${error.message}` : '', checkedAt: new Date().toISOString() });
      } finally { this.busy = null; }
      return this.state;
    })();
    return this.busy;
  }
  download() {
    if (this.busy) return this.busy;
    if (!this.release || !['available', 'error'].includes(this.state.status)) return Promise.reject(new Error('There is no update to download.'));
    const release = this.release;
    this.update({ status: 'downloading', progress: 0, message: '' });
    this.busy = (async () => {
      const folder = path.join(this.directory, release.version);
      try {
        const sums = verifiedChecksums(await this.text(release.sums, 64 * 1024), await this.text(release.signature, 1024), this.publicKey);
        const expected = sums.get(release.asset.name);
        if (!expected) throw new Error('The update is missing from its signed checksums.');
        fs.rmSync(this.directory, { recursive: true, force: true }); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, release.asset.name);
        // Installers are about 130 MB; allow slow connections plenty of time.
        const response = await this.request(release.asset.url, { timeout: 60 * 60 * 1000 });
        const total = Number(response.headers.get('content-length')) || 0, hash = createHash('sha256'), output = fs.createWriteStream(file, { mode: 0o600 });
        let received = 0, reported = 0;
        for await (const chunk of response.body) {
          hash.update(chunk); received += chunk.length;
          if (!output.write(chunk)) await once(output, 'drain');
          if (total && received / total - reported >= 0.01) { reported = received / total; this.update({ progress: Math.min(1, reported) }); }
        }
        output.end(); await once(output, 'close');
        if (hash.digest('hex') !== expected) throw new Error('The download did not match its signed checksum, so it was discarded.');
        this.prepared = { version: release.version, file, app: this.platform === 'darwin' ? await this.unpack(file, folder, release.version) : null };
        this.update({ status: 'ready', progress: 1 });
        this.log(`DropoVPN ${release.version} is downloaded and verified.`);
      } catch (error) {
        fs.rmSync(folder, { recursive: true, force: true });
        this.update({ status: 'error', progress: 0, message: `The update couldn’t be downloaded: ${error.message}` });
        this.log(`Update failed: ${error.message}`, 'warning');
      } finally { this.busy = null; }
      return this.state;
    })();
    return this.busy;
  }
  async unpack(file, folder, version) {
    const target = path.join(folder, 'app');
    await execute('/usr/bin/ditto', ['-x', '-k', file, target]);
    const app = path.join(target, 'DropoVPN.app'), plist = path.join(app, 'Contents', 'Info.plist');
    const read = async key => (await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
    if (await read('CFBundleIdentifier') !== 'com.dropovpn.desktop' || await read('CFBundleShortVersionString') !== version) throw new Error('The downloaded app is not the expected DropoVPN version.');
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    return app;
  }
  // Start the installer and let the caller quit DropoVPN.
  install({ pid = process.pid } = {}) {
    if (this.state.status !== 'ready' || !this.prepared) throw new Error('Download the update first.');
    const { file, app } = this.prepared;
    if (this.platform === 'darwin') {
      const bundle = bundleOf(this.execPath, this.platform);
      if (!bundle?.writable) { this.spawnProcess('/usr/bin/open', ['-R', app], { detached: true, stdio: 'ignore' }).unref(); return false; }
      const script = path.join(path.dirname(file), 'install.sh');
      fs.writeFileSync(script, MAC_INSTALLER, { mode: 0o700 });
      this.spawnProcess('/bin/sh', [script, String(pid), bundle.path, app], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const command = Buffer.from(windowsInstaller({ pid, installer: file, executable: this.execPath, log: path.join(path.dirname(file), 'install.log') }), 'utf16le').toString('base64');
      this.spawnProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', command], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    this.update({ status: 'installing' });
    return true;
  }
}
