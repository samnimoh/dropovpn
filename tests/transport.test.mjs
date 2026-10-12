import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { acceptWebSocket, connectWebSocket } from '../electron/websocket.mjs';
import { Mux } from '../electron/mux.mjs';
import { SecureChannel, createInvite, discoveryPacket, meshKeys, parseInvite, readDiscovery } from '../electron/meshcrypto.mjs';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function until(predicate, ms = 3000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const collect = stream => new Promise((resolve, reject) => { const parts = []; stream.on('data', part => parts.push(part)); stream.on('end', () => resolve(Buffer.concat(parts))); stream.on('error', reject); });

function echoServer(t) {
  const server = http.createServer((_request, response) => response.end('plain http'));
  server.on('upgrade', (request, socket, head) => {
    const ws = acceptWebSocket(request, socket, head);
    ws?.on('message', (data, binary) => ws.send(binary ? data : 'echo:' + data));
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('WebSocket server interoperates with the Node.js WebSocket client', async t => {
  const port = await echoServer(t);
  const client = new WebSocket(`ws://127.0.0.1:${port}/`); client.binaryType = 'arraybuffer';
  const messages = [];
  client.onmessage = event => messages.push(event.data);
  await new Promise((resolve, reject) => { client.onopen = resolve; client.onerror = reject; });
  const large = randomBytes(300 * 1024);
  client.send('hello'); client.send(large);
  await until(() => messages.length === 2);
  assert.equal(messages[0], 'echo:hello');
  assert.equal(sha(Buffer.from(messages[1])), sha(large));
  client.close();
});

test('WebSocket client reassembles fragments, answers pings, and enforces message limits', async t => {
  const port = await echoServer(t);
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/`);
  const got = []; ws.on('message', data => got.push(data));
  ws.send('first'); ws.send(Buffer.from([1, 2, 3]));
  await until(() => got.length === 2);
  assert.equal(got[0], 'echo:first'); assert.deepEqual([...got[1]], [1, 2, 3]);
  ws.close(); await until(() => ws.closed);

  // Raw server frames: a fragmented text message with a ping between the fragments.
  const raw = http.createServer();
  raw.on('upgrade', (request, socket, head) => {
    acceptWebSocket(request, socket, head);
    socket.write(Buffer.from([0x01, 0x03, ...Buffer.from('abc'), 0x89, 0x00, 0x80, 0x03, ...Buffer.from('def')]));
  });
  t.after(() => raw.close());
  await new Promise(resolve => raw.listen(0, '127.0.0.1', resolve));
  const client = await connectWebSocket(`ws://127.0.0.1:${raw.address().port}/`, { maxMessage: 16 });
  const fragments = []; client.on('message', data => fragments.push(data));
  await until(() => fragments.length === 1);
  assert.equal(fragments[0], 'abcdef');
  const closed = new Promise(resolve => client.on('close', code => resolve(code)));
  client.socket.emit('data', Buffer.from([0x82, 0x20, ...randomBytes(32)]));
  assert.equal(await closed, 1009);
});

function pair({ delay = true } = {}) {
  const deliver = (target, frame) => delay ? setImmediate(() => target.receive(frame)) : target.receive(frame);
  const left = new Mux({ send: frame => deliver(right, frame), initiator: true, keepalive: 0 });
  const right = new Mux({ send: frame => deliver(left, frame), initiator: false, keepalive: 0 });
  return { left, right };
}

test('multiplexed streams carry large transfers in both directions intact', async () => {
  const { left, right } = pair();
  const up = randomBytes(3 * 1024 * 1024 + 17), down = randomBytes(2 * 1024 * 1024 + 5);
  const accepted = new Promise(resolve => right.once('stream', (stream, meta) => resolve({ stream, meta })));
  const client = left.open({ service: 'web' });
  const { stream: server, meta } = await accepted;
  assert.deepEqual(meta, { service: 'web' });
  const [fromClient, fromServer] = [collect(server), collect(client)];
  client.end(up); server.end(down);
  assert.equal(sha(await fromClient), sha(up));
  assert.equal(sha(await fromServer), sha(down));
  await until(() => left.streams.size === 0 && right.streams.size === 0);
  left.close(); right.close();
});

test('flow control stops a sender when the receiver is not reading', async () => {
  const { left, right } = pair();
  let receiver; right.on('stream', stream => { receiver = stream; stream.pause(); });
  const sender = left.open({}); let written = 0;
  const payload = randomBytes(4 * 1024 * 1024);
  sender.write(payload, () => { written = payload.length; });
  await until(() => receiver && receiver.readableLength > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(receiver.readableLength <= 256 * 1024, `receiver buffered ${receiver.readableLength} bytes`);
  assert.equal(written, 0);
  const received = collect(receiver); sender.end(); receiver.resume();
  assert.equal((await received).length, payload.length);
  assert.equal(written, payload.length);
  left.close(); right.close();
});

test('a reset or closed connection tears down streams on both sides', async () => {
  const { left, right } = pair();
  let remote; right.on('stream', stream => { remote = stream; });
  const local = left.open({});
  await until(() => remote);
  const error = new Promise(resolve => remote.on('error', resolve));
  local.destroy(new Error('Target refused the connection'));
  assert.match((await error).message, /refused/);
  const second = left.open({}); let other; right.once('stream', stream => { other = stream; });
  await until(() => other);
  const closed = new Promise(resolve => second.on('close', resolve));
  right.close(new Error('Peer stopped'));
  left.close(new Error('Peer stopped'));
  await closed;
  assert.equal(second.destroyed, true); assert.equal(other.destroyed, true);
  assert.throws(() => left.open({}), /closed/);
});

test('mux refuses streams from the wrong side and survives malformed frames', async () => {
  const sent = [];
  const mux = new Mux({ send: frame => sent.push(frame), initiator: true, keepalive: 0 });
  let opened = 0; mux.on('stream', () => opened++);
  const odd = Buffer.concat([Buffer.from([1, 0, 0, 0, 3]), Buffer.from('{}')]);
  mux.receive(odd);
  assert.equal(opened, 0); assert.equal(sent.at(-1)[0], 5);
  const even = Buffer.concat([Buffer.from([1, 0, 0, 0, 4]), Buffer.from('not json')]);
  mux.receive(even); assert.equal(opened, 0);
  mux.receive(Buffer.from([2, 0, 0]));
  assert.equal(mux.closed, true);
});

test('invites round-trip and reject tampering', () => {
  const secret = randomBytes(32);
  const invite = createInvite({ secret, relayURL: 'wss://relay.example.com/', relayToken: 'a-long-relay-access-token' });
  const parsed = parseInvite(invite);
  assert.equal(parsed.secret.equals(secret), true);
  assert.equal(parsed.relayURL, 'wss://relay.example.com/'); assert.equal(parsed.relayToken, 'a-long-relay-access-token');
  assert.deepEqual(parseInvite(createInvite({ secret })).relayURL, '');
  assert.throws(() => parseInvite(invite.slice(0, -4)), /not valid/);
  assert.throws(() => parseInvite('dropo1.' + Buffer.from(JSON.stringify({ k: secret.toString('base64url'), r: 'https://relay.example.com' })).toString('base64url')), /relay address/);
  assert.throws(() => parseInvite('hello'), /not valid/);
});

function handshake(initiatorKeys, responderKeys) {
  const ids = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
  const wire = [];
  let a, b;
  a = new SecureChannel({ keys: initiatorKeys, deviceId: ids[0], initiator: true, send: message => { wire.push(Buffer.from(message)); setImmediate(() => b.receive(message)); } });
  b = new SecureChannel({ keys: responderKeys, deviceId: ids[1], initiator: false, send: message => setImmediate(() => a.receive(message)) });
  return { a, b, ids, wire };
}

test('secure channels authenticate the mesh, encrypt records, and reject replays', async () => {
  const keys = meshKeys(randomBytes(32));
  const { a, b, ids, wire } = handshake(keys, keys);
  const records = [];
  let opened = 0; a.on('open', () => { opened++; a.write(Buffer.from('catalog from initiator')); }); b.on('open', () => opened++);
  b.on('record', record => records.push(record.toString()));
  a.start();
  await until(() => opened === 2);
  assert.equal(a.peerId, ids[1]); assert.equal(b.peerId, ids[0]);
  assert.deepEqual(records, ['catalog from initiator']);
  assert.equal(wire.some(message => message.includes(Buffer.from('catalog from initiator'))), false);

  // A replayed first message gets a response but never opens a session.
  const replay = new SecureChannel({ keys, deviceId: randomBytes(16).toString('hex'), initiator: false, send: () => {}, timeout: 50 });
  let replayOpened = false; replay.on('open', () => { replayOpened = true; });
  replay.receive(wire[0]); replay.receive(wire[1]);
  await until(() => replay.closed);
  assert.equal(replayOpened, false);

  // Tampering with a record closes the channel.
  const closed = new Promise(resolve => b.on('close', resolve));
  const record = wire.at(-1); record[5] ^= 1; b.receive(record);
  assert.match(await closed, /authentication/);
});

test('devices with a different mesh key cannot complete a handshake', async () => {
  const { a, b } = handshake(meshKeys(randomBytes(32)), meshKeys(randomBytes(32)));
  const reasons = []; a.on('close', reason => reasons.push(reason)); b.on('close', reason => reasons.push(reason));
  let opened = false; a.on('open', () => { opened = true; }); b.on('open', () => { opened = true; });
  a.start();
  await until(() => b.closed);
  assert.equal(opened, false); assert.match(reasons[0], /not part of your mesh/);
  a.close();
});

test('LAN discovery packets verify, expire, and ignore other meshes', () => {
  const keys = meshKeys(randomBytes(32)), device = randomBytes(16).toString('hex');
  const packet = discoveryPacket(keys, device, 47820, 1_000_000);
  assert.deepEqual(readDiscovery(keys, packet, 1_000_500), { deviceId: device, port: 47820 });
  assert.equal(readDiscovery(keys, packet, 1_000_000 + 121000), null);
  assert.equal(readDiscovery(meshKeys(randomBytes(32)), packet, 1_000_500), null);
  const forged = Buffer.from(packet); forged[27] ^= 1;
  assert.equal(readDiscovery(keys, forged, 1_000_500), null);
  // The device id is masked differently in every announcement.
  const again = discoveryPacket(keys, device, 47820, 1_000_000);
  assert.equal(packet.includes(Buffer.from(device, 'hex')), false);
  assert.notDeepEqual(packet.subarray(10, 34), again.subarray(10, 34));
  assert.equal(readDiscovery(keys, again, 1_000_500).deviceId, device);
});
