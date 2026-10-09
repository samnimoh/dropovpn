// Validate a private profile with the real engine, exclusively against loopback.
// No tunnel, elevation, system routes, DNS changes, or server sign-in occurs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { importProfile } from '../electron/profile.mjs';
import { detectEngine, managementArguments } from '../electron/launcher.mjs';
import { VPN } from '../electron/vpn.mjs';
import { safeLog } from '../electron/protocol.mjs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/check-profile.mjs /path/to/profile.ovpn');
const parsed = importProfile(path.resolve(filename));
const engine = await detectEngine();
if (!engine.available) throw new Error('Install OpenVPN 2.6+ to validate this profile.');
// Replace every top-level remote entry before the engine reads the profile.
const config = parsed.config.replace(/^remote .*$/gm, 'remote 127.0.0.1 65530 udp');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-profile-check-'));
fs.chmodSync(directory, 0o700);
let child, output = '';
const store = { config: () => config, profile: () => parsed, credentials: () => ({ username: 'offline-validation', password: 'offline-validation' }), data: { settings: { autoReconnect: false } } };
const vpn = new VPN({ store, startupTimeout: 7000, launch({ config, port, token }) {
  fs.writeFileSync(path.join(directory, 'profile.ovpn'), config, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'management.pass'), token + '\n', { mode: 0o600 });
  child = spawn(engine.path, ['--config', 'profile.ovpn', ...managementArguments(port), '--dev', 'null', '--ifconfig-noexec', '--route-noexec'], { cwd: directory });
  child.stdout.on('data', b => { output = (output + b).slice(-64000); });
  child.stderr.on('data', b => { output = (output + b).slice(-64000); });
  return child;
} });
try {
  await vpn.connect('offline-profile', null, engine);
  const started = Date.now();
  while (!output.includes('UDPv4 link remote: [AF_INET]127.0.0.1:65530') && vpn.state.status !== 'error' && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 20));
  if (!vpn.session?.authenticated || !output.includes('UDPv4 link remote: [AF_INET]127.0.0.1:65530')) {
    const diagnostic = output.split('\n').filter(line => /Error|ERROR|FATAL|Options error/.test(line)).map(line => safeLog(line)).filter(Boolean).slice(-5).join('\n');
    throw new Error(diagnostic || 'The engine could not load the profile. Check whether the private key needs a passphrase.');
  }
  console.log(JSON.stringify({ valid: true, engine: engine.version, requiresAuth: parsed.requiresAuth, loopbackOnly: true, tunnelCreated: false, legacyAES: /data-ciphers-fallback "AES-(128|192|256)-CBC"/.test(config) }));
} finally {
  await vpn.disconnect(); child?.kill(); fs.rmSync(directory, { recursive: true, force: true });
}
