import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VPN } from '../electron/vpn.mjs';

const config = 'client\ndev tun\nremote vpn.test\nauth-user-pass\n<ca>\ncertificate\n</ca>\n';
const credentials = { username: 'sam', password: 'correct-horse' };
const engine = { available: true, path: '/test/openvpn' };
export async function until(predicate, ms = 2000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 5)); } }

function fixture(t, opts = {}) {
  let saved = opts.noSaved ? null : credentials;
  const store = { profile: () => ({ requiresAuth: true }), config: () => config, credentials: () => saved, saveCredentials: (_id, value) => { saved = value; }, forget: () => { saved = null; }, data: { settings: { autoReconnect: true } } };
  const instances = [];
  const launch = ({ port, token, config }) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    const socket = net.connect(port, '127.0.0.1');
    const commands = []; let buffer = '';
    child.send = line => socket.write(line + '\r\n'); child.commands = commands;
    child.crash = code => { child.exitCode = code; socket.destroy(); child.emit('close', code); };
    socket.on('connect', () => { socket.write('ENTER PASS'); socket.write('WORD:'); });
    socket.on('error', () => {});
    socket.on('close', () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('close', 0); } });
    socket.on('data', bytes => {
      buffer += String(bytes); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = buffer.slice(0, end); buffer = buffer.slice(end + 1); commands.push(command);
        if (command === token) child.send('SUCCESS: password is correct');
        if (command === 'echo all') { child.send(`1,dropovpn-peer:${opts.rogue ? 'incorrect-proof' : config.match(/dropovpn-peer:([a-f0-9]+)/)[1]}`); child.send('END'); }
        if (command !== token && command !== 'echo all') child.send('SUCCESS: command accepted');
        if (command === 'hold release') child.send(">PASSWORD:Need 'Auth' username/password");
      }
    });
    instances.push(child); return child;
  };
  const vpn = new VPN({ store, launch, startupTimeout: opts.timeout || 2000, retryDelay: 25 });
  t.after(async () => { await vpn.disconnect(); });
  return { vpn, store, instances, saved: () => saved };
}
test('reuses saved credentials across transient reconnection without a sign-in prompt', async t => {
  const { vpn, instances } = fixture(t); await vpn.connect('work', null, engine);
  await until(() => instances[0].commands.some(c => c.includes('correct-horse')));
  const child = instances[0]; child.send('>STATE:1,CONNECTED,SUCCESS,10.0.0.2,203.0.113.1');
  await until(() => vpn.state.status === 'connected');
  child.send('>STATE:2,RECONNECTING,ping-restart'); child.send(">PASSWORD:Need 'Auth' username/password");
  await until(() => child.commands.filter(c => c.includes('correct-horse')).length === 2);
  assert.equal(vpn.state.status, 'reconnecting'); assert.equal(vpn.state.prompt, null);
  child.send('>STATE:3,CONNECTED,SUCCESS,10.0.0.3,203.0.113.1'); child.send('>BYTECOUNT:100,200');
  await until(() => vpn.state.sent === 200); assert.equal(vpn.state.status, 'connected');
});
test('prompts without saved credentials and persists only when remember is checked', async t => {
  const { vpn, saved, instances } = fixture(t, { noSaved: true });
  await vpn.connect('work', null, engine); assert.equal(vpn.state.status, 'credentials-required'); assert.equal(instances.length, 0);
  await vpn.submit({ ...credentials, remember: true, privateKey: false }, engine);
  assert.deepEqual(saved(), credentials); await until(() => vpn.session.authenticated);
});
test('rejected credentials pause automatic submission until corrected', async t => {
  const { vpn, instances } = fixture(t); await vpn.connect('work', null, engine); await until(() => instances[0].commands.some(c => c.includes('correct-horse')));
  const child = instances[0]; child.send(">PASSWORD:Verification Failed: 'Auth'"); child.send(">PASSWORD:Need 'Auth' username/password");
  await until(() => vpn.state.status === 'credentials-required');
  assert.equal(child.commands.filter(c => c.includes('correct-horse')).length, 1);
  await vpn.submit({ username: 'sam', password: 'new-password', remember: false, privateKey: false }, engine);
  await until(() => child.commands.some(c => c.includes('new-password'))); assert.notEqual(vpn.state.status, 'credentials-required');
});
test('manual disconnect closes the tunnel and never schedules reconnection', async t => {
  const { vpn, instances } = fixture(t); await vpn.connect('work', null, engine); await until(() => vpn.session.authenticated);
  await vpn.disconnect(); assert.equal(vpn.state.status, 'disconnected'); assert.equal(vpn.session, null); assert.equal(vpn.retryTimer, null); assert.equal(instances.length, 1);
});
test('disabling auto reconnect stops a dropped established connection', async t => {
  const { vpn, instances, store } = fixture(t); await vpn.connect('work', null, engine); await until(() => vpn.session.authenticated);
  instances[0].send('>STATE:1,CONNECTED,SUCCESS,10.0.0.2,1.2.3.4'); await until(() => vpn.state.status === 'connected'); store.data.settings.autoReconnect = false;
  instances[0].send('>STATE:2,RECONNECTING,ping-restart'); await until(() => vpn.state.status === 'disconnected'); assert.equal(instances.length, 1);
});
test('wake from sleep requests an OpenVPN reconnect', async t => {
  const { vpn, instances } = fixture(t); await vpn.connect('work', null, engine); await until(() => vpn.session.authenticated); vpn.resume();
  await until(() => instances[0].commands.includes('signal SIGUSR1'));
});
test('a crashed established engine restarts with session credentials', async t => {
  const { vpn, instances } = fixture(t); await vpn.connect('work', null, engine); await until(() => vpn.session.authenticated);
  instances[0].send('>STATE:1,CONNECTED,SUCCESS,10.0.0.2,1.2.3.4'); await until(() => vpn.state.status === 'connected'); instances[0].crash(2);
  await until(() => instances.length === 2 && instances[1].commands.some(c => c.includes('correct-horse')));
});
test('an impersonated engine cannot obtain VPN credentials without independent proof', async t => {
  const { vpn, instances } = fixture(t, { rogue: true, timeout: 60 }); await vpn.connect('work', null, engine);
  await until(() => vpn.state.status === 'error'); assert.equal(instances[0].commands.some(c => c.includes('correct-horse')), false);
});
test('a cancellation while elevation is pending leaves no listener or credentials', async t => {
  const { vpn } = fixture(t); const starting = vpn.connect('work', null, engine); const stopping = vpn.disconnect(); await Promise.all([starting, stopping]);
  assert.equal(vpn.session, null); assert.equal(vpn.state.status, 'disconnected');
});
