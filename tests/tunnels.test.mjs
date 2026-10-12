import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Tunnels, TOOLS, toolCandidates } from '../electron/tunnels.mjs';

async function until(predicate, ms = 5000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(resolve => setTimeout(resolve, 10)); } }
// Stand-in agents: a Node.js process that prints what the real tool would.
function fake(script) {
  const calls = [];
  const spawnProcess = (binary, args, options) => { calls.push({ binary, args }); return spawn(process.execPath, ['-e', script], options); };
  return { calls, spawnProcess };
}
const tools = { cloudflared: { available: true, path: '/opt/tools/cloudflared', version: '2025.9.0' }, ngrok: { available: true, path: '/opt/tools/ngrok', version: '3.39.11' } };
const manager = (t, options) => { const tunnels = new Tunnels({ getMesh: () => null, detect: async name => tools[name], ...options }); t.after(() => tunnels.stopAll()); return tunnels; };

test('starts a Cloudflare quick tunnel with the local Host header and reports its URL', async t => {
  const { calls, spawnProcess } = fake("console.error('INF Requesting new quick Tunnel'); setTimeout(() => console.error('INF |  https://quiet-river-moon.trycloudflare.com  |'), 50); setInterval(() => {}, 1000);");
  const tunnels = manager(t, { spawnProcess }); await tunnels.refresh();
  const id = await tunnels.start({ provider: 'cloudflared', target: '5173' });
  assert.equal(tunnels.snapshot().list[0].status, 'starting');
  await until(() => tunnels.snapshot().list[0].status === 'online');
  assert.equal(tunnels.snapshot().list[0].url, 'https://quiet-river-moon.trycloudflare.com');
  assert.deepEqual(calls[0], { binary: '/opt/tools/cloudflared', args: ['tunnel', '--no-autoupdate', '--url', 'http://localhost:5173', '--http-host-header', 'localhost:5173'] });
  tunnels.stop(id);
  assert.deepEqual(tunnels.snapshot().list, []);
});

test('reports ngrok sign-in problems instead of a generic failure', async t => {
  const { calls, spawnProcess } = fake(`console.log(JSON.stringify({ lvl: 'eror', msg: 'session closing', err: 'authentication failed: Usage of ngrok requires a verified account and authtoken.\\n\\nERR_NGROK_4018' })); process.exit(1);`);
  const tunnels = manager(t, { spawnProcess }); await tunnels.refresh();
  await tunnels.start({ provider: 'ngrok', target: 'http://localhost:3000' });
  await until(() => tunnels.snapshot().list[0].status === 'error');
  assert.match(tunnels.snapshot().list[0].message, /^authentication failed: Usage of ngrok requires a verified account and authtoken\.$/);
  assert.ok(calls[0].args.includes('--host-header=rewrite'));
  assert.equal(TOOLS.ngrok.url(JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://abc-123.ngrok-free.app' })), 'https://abc-123.ngrok-free.app');
});

test('times out an agent that never prints a URL and stops it', async t => {
  const { spawnProcess } = fake('setInterval(() => {}, 1000);');
  const tunnels = manager(t, { spawnProcess, startTimeout: 100 }); await tunnels.refresh();
  await tunnels.start({ provider: 'cloudflared', target: 'localhost:8080' });
  await until(() => tunnels.snapshot().list[0].status === 'error');
  assert.match(tunnels.snapshot().list[0].message, /did not report a public address/);
});

test('validates targets, names and missing tools', async t => {
  const tunnels = manager(t, { detect: async () => ({ available: false, path: '', version: null }) });
  await assert.rejects(tunnels.start({ provider: 'cloudflared', target: 'localhost:3000' }), /Install cloudflared/);
  await assert.rejects(tunnels.start({ provider: 'ngrok', target: 'tcp://localhost:5432' }), /http:\/\//);
  await assert.rejects(tunnels.start({ provider: 'relay', target: '3000', name: 'Not Valid' }), /lowercase/);
  await assert.rejects(tunnels.start({ provider: 'relay', target: '3000' }), /Device mesh/);
  await assert.rejects(tunnels.start({ provider: 'teleport', target: '3000' }), /Choose/);
});

test('relay URLs follow the mesh connection state', async t => {
  const mesh = Object.assign(new EventEmitter(), { relay: { status: 'connected', publicTunnels: true }, exposed: new Map(), unexposed: [] });
  mesh.expose = async ({ id, name }) => { mesh.exposed.set(id, { url: `https://${name}.tunnels.example.com`, online: true, error: '' }); return mesh.exposed.get(id).url; };
  mesh.unexpose = id => { mesh.unexposed.push(id); mesh.exposed.delete(id); };
  const tunnels = manager(t, { getMesh: () => mesh });
  assert.equal(tunnels.snapshot().tools.relay.available, true);
  const id = await tunnels.start({ provider: 'relay', target: '3000', name: 'demo' });
  await until(() => tunnels.snapshot().list[0].status === 'online');
  assert.equal(tunnels.snapshot().list[0].url, 'https://demo.tunnels.example.com');
  mesh.exposed.get(id).online = false;
  assert.equal(tunnels.snapshot().list[0].status, 'reconnecting');
  tunnels.stop(id); assert.deepEqual(mesh.unexposed, [id]);
  mesh.relay.publicTunnels = false;
  assert.match(tunnels.snapshot().tools.relay.reason, /DROPO_PUBLIC_DOMAIN/);
});

test('finds tools on PATH and in standard install locations, never in relative directories', () => {
  const mac = toolCandidates('cloudflared', { platform: 'darwin', env: { PATH: '/usr/bin:.:bin' } });
  assert.deepEqual(mac, ['/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']);
  const windows = toolCandidates('ngrok', { platform: 'win32', env: { Path: 'C:\\Tools;relative', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' } });
  assert.ok(windows.includes(path.win32.join('C:\\Tools', 'ngrok.exe')));
  assert.ok(windows.includes('C:\\Program Files\\ngrok\\ngrok.exe'));
  assert.ok(windows.includes('C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Links\\ngrok.exe'));
  assert.equal(windows.some(candidate => candidate.startsWith('relative')), false);
});
