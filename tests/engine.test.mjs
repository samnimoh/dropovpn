import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectEngine, managementArguments } from '../electron/launcher.mjs';
import { VPN } from '../electron/vpn.mjs';

test('real OpenVPN: authenticates management, queries credentials, and exits on disconnect without a tunnel', { timeout: 15000 }, async t => {
  const engine = await detectEngine(process.env.DROPOVPN_ENGINE || ''); if (!engine.available) { t.skip('Build the included runtime or install OpenVPN 2.6+ to run the real-engine integration test.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-engine-'));
  const config = `client\ndev tun\nremote 127.0.0.1 65530 udp\nauth-user-pass\npeer-fingerprint ${Array(32).fill('AA').join(':')}\n`;
  const store = { config: () => config, profile: () => ({ requiresAuth: true }), credentials: () => ({ username: 'test-user', password: 'test-password' }), data: { settings: { autoReconnect: true } } };
  let child, output = '';
  const vpn = new VPN({ store, startupTimeout: 7000, launch({ config, port, token }) {
    fs.writeFileSync(path.join(directory, 'profile.ovpn'), config); fs.writeFileSync(path.join(directory, 'management.pass'), token + '\n');
    // dev null ensures this test never creates a tunnel, changes routes or DNS,
    // or requests elevation. It still exercises the real management protocol.
    child = spawn(engine.path, ['--config', 'profile.ovpn', ...managementArguments(port), '--dev', 'null', '--ifconfig-noexec', '--route-noexec'], { cwd: directory });
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); return child;
  } });
  t.after(async () => { await vpn.disconnect(); child?.kill(); fs.rmSync(directory, { recursive: true, force: true }); });
  await vpn.connect('test', null, engine);
  const started = Date.now(); while (!output.includes('UDPv4 link remote') && vpn.state.status !== 'error' && Date.now() - started < 10000) await new Promise(r => setTimeout(r, 20));
  assert.equal(vpn.session?.authenticated, true, output);
  assert.match(output, /UDPv4 link remote/, output);
  assert.doesNotMatch(JSON.stringify(vpn.logs), /test-password/);
  await vpn.disconnect(); assert.equal(vpn.state.status, 'disconnected'); assert.notEqual(child.exitCode, null);
});
