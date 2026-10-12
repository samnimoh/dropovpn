import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { parseTarget } from './mesh.mjs';

const execute = promisify(execFile);
const clean = value => String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
export const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Public URL providers that run as the user's own installed agent. Neither
// binary is bundled; DropoVPN only starts one when the user asks for a URL.
export const TOOLS = {
  cloudflared: {
    label: 'Cloudflare', versionArgs: ['--version'], version: /cloudflared version (\S+)/,
    args: target => ['tunnel', '--no-autoupdate', '--url', target.url, '--http-host-header', target.address],
    url: line => line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0],
    error: line => line.match(/\bERR\s+(.+)/)?.[1]
  },
  ngrok: {
    label: 'ngrok', versionArgs: ['version'], version: /ngrok version (\S+)/,
    args: target => ['http', target.url, '--log', 'stdout', '--log-format', 'json', '--inspect=false', '--host-header=rewrite'],
    url: line => { try { const value = JSON.parse(line); return value.msg === 'started tunnel' && /^https:\/\/[a-z0-9.-]+$/.test(value.url) ? value.url : null; } catch { return null; } },
    error: line => {
      try { const value = JSON.parse(line); return ['eror', 'crit'].includes(value.lvl) && typeof value.err === 'string' ? value.err.split(/\r?\n/)[0] : null; }
      catch { return line.match(/^ERROR:\s+(.+)/)?.[1]; }
    }
  }
};

export function toolCandidates(name, { platform = process.platform, env = process.env } = {}) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  const directories = String(env.PATH || env.Path || '').split(windows ? ';' : ':');
  if (platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin');
  if (windows) {
    const local = env.LOCALAPPDATA;
    directories.push(paths.join(env.ProgramFiles || 'C:\\Program Files', name), paths.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', name), ...(local ? [paths.join(local, 'Microsoft', 'WinGet', 'Links'), paths.join(local, 'Microsoft', 'WindowsApps')] : []));
  }
  // Relative PATH entries would resolve against the app's working directory.
  return [...new Set(directories.filter(directory => directory && paths.isAbsolute(directory)).map(directory => paths.join(directory, windows ? name + '.exe' : name)))];
}

export async function detectTool(name, options) {
  const tool = TOOLS[name];
  for (const candidate of toolCandidates(name, options)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const { stdout, stderr } = await execute(candidate, tool.versionArgs, { timeout: 5000, windowsHide: true });
      const version = (stdout + stderr).match(tool.version);
      if (version) return { available: true, path: candidate, version: version[1] };
    } catch { /* Try the next location. */ }
  }
  return { available: false, path: '', version: null };
}

function eachLine(stream, callback) {
  let buffer = '';
  stream?.setEncoding('utf8');
  stream?.on('data', chunk => {
    buffer = (buffer + chunk).slice(-65536);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { callback(buffer.slice(0, index).slice(0, 8192)); buffer = buffer.slice(index + 1); }
  });
}

export class Tunnels extends EventEmitter {
  constructor({ getMesh, detect = detectTool, spawnProcess = spawn, log = () => {}, startTimeout = 60000 }) {
    super(); Object.assign(this, { getMesh, detect, spawnProcess, log, startTimeout });
    this.list = []; this.tools = { cloudflared: { available: false, path: '', version: null }, ngrok: { available: false, path: '', version: null } };
  }
  async refresh() {
    for (const name of Object.keys(TOOLS)) this.tools[name] = await this.detect(name);
    this.emit('change');
  }
  snapshot() {
    const mesh = this.getMesh();
    const relay = mesh?.relay.status !== 'connected' ? { available: false, reason: 'Connect a relay in Device mesh to use your own domain.' } : !mesh.relay.publicTunnels ? { available: false, reason: 'Your relay has no public domain. Set DROPO_PUBLIC_DOMAIN on the relay.' } : { available: true, reason: '' };
    return {
      tools: { relay, cloudflared: { ...this.tools.cloudflared }, ngrok: { ...this.tools.ngrok } },
      list: this.list.map(({ id, provider, target, url, status, message, startedAt }) => {
        if (provider !== 'relay' || status === 'starting' || status === 'error') return { id, provider, target, url, status, message, startedAt };
        const exposed = mesh?.exposed.get(id);
        if (!exposed) return { id, provider, target, url, status: 'error', message: 'The relay connection ended.', startedAt };
        return { id, provider, target, url: exposed.url || url, status: exposed.online ? 'online' : exposed.error ? 'error' : 'reconnecting', message: exposed.error, startedAt };
      })
    };
  }
  async start({ provider, target: value, name = '' }) {
    if (!['relay', ...Object.keys(TOOLS)].includes(provider)) throw new Error('Choose how to share this address.');
    const target = parseTarget(value);
    if (target.protocol !== 'http') throw new Error('Public URLs carry web traffic. Use an http:// address.');
    if (typeof name !== 'string' || (name && (provider !== 'relay' || !NAME.test(name)))) throw new Error('Names use 1 to 40 lowercase letters, numbers and dashes.');
    if (this.list.filter(item => item.status !== 'error').length >= 8) throw new Error('Stop a public URL before starting another.');
    const tunnel = { id: randomBytes(8).toString('hex'), provider, target: `http://${target.address}`, url: null, status: 'starting', message: '', startedAt: new Date().toISOString(), process: null, stopping: false };
    if (provider === 'relay') {
      const mesh = this.getMesh();
      if (!mesh) throw new Error('Set up Device mesh with a relay first.');
      this.list.push(tunnel);
      mesh.expose({ id: tunnel.id, name, host: target.host, port: target.port }).then(url => {
        if (tunnel.stopping) return;
        Object.assign(tunnel, { url, status: 'online' }); this.log(`Public URL started: ${url}`); this.emit('change');
      }, error => this.fail(tunnel, error.message));
    } else {
      if (!this.tools[provider].available) this.tools[provider] = await this.detect(provider);
      const tool = this.tools[provider];
      if (!tool.available) throw new Error(provider === 'cloudflared' ? 'Install cloudflared to create Cloudflare quick tunnels.' : 'Install ngrok and add your authtoken to use ngrok.');
      this.list.push(tunnel); this.launch(tunnel, tool, TOOLS[provider], { ...target, url: tunnel.target });
    }
    this.emit('change');
    return tunnel.id;
  }
  launch(tunnel, tool, definition, target) {
    let lastError = '', child;
    try { child = this.spawnProcess(tool.path, definition.args(target), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { this.fail(tunnel, `Could not start ${definition.label}: ${error.message}`); return; }
    tunnel.process = child;
    const timer = setTimeout(() => { if (tunnel.status === 'starting') { this.fail(tunnel, lastError || `${definition.label} did not report a public address. Check your internet connection.`); child.kill(); } }, this.startTimeout);
    const line = text => {
      const url = definition.url(text), error = definition.error(text);
      if (error) lastError = clean(error);
      if (url && tunnel.status === 'starting' && !tunnel.stopping) {
        Object.assign(tunnel, { url, status: 'online' }); clearTimeout(timer);
        this.log(`Public URL started with ${definition.label}: ${url}`); this.emit('change');
      }
    };
    eachLine(child.stdout, line); eachLine(child.stderr, line);
    child.on('error', error => { clearTimeout(timer); this.fail(tunnel, `Could not start ${definition.label}: ${error.message}`); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!tunnel.stopping && tunnel.status !== 'error') this.fail(tunnel, lastError || (tunnel.status === 'online' ? `${definition.label} stopped unexpectedly.` : `${definition.label} exited before creating a public URL.`));
    });
  }
  fail(tunnel, message) {
    if (tunnel.stopping) return;
    Object.assign(tunnel, { status: 'error', message: clean(message), process: null });
    this.log(`Public URL stopped: ${tunnel.message}`, 'warning'); this.emit('change');
  }
  stop(id) {
    const tunnel = this.list.find(item => item.id === id);
    if (!tunnel) return;
    tunnel.stopping = true; tunnel.process?.kill();
    if (tunnel.provider === 'relay') this.getMesh()?.unexpose(id);
    this.list = this.list.filter(item => item !== tunnel);
    if (tunnel.status === 'online') this.log(`Public URL stopped: ${tunnel.url}`);
    this.emit('change');
  }
  stopAll(provider) { for (const tunnel of [...this.list]) if (!provider || tunnel.provider === provider) this.stop(tunnel.id); }
}
