import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { MeshAgent, parseTarget } from '../electron/mesh.mjs';
import * as websocket from '../electron/websocket.mjs';
const { acceptWebSocket, connectWebSocket } = websocket;
import { createRelay } from '../relay/server.mjs';

const token = 'test-relay-access-token-0123456789';
const deviceId = () => randomBytes(16).toString('hex');
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function until(predicate, ms = 5000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const listening = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function get(port, { path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers, agent: false }, response => {
      const parts = []; response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
}

// A local "dev server" that reports what it received.
async function devServer(t, large = randomBytes(1)) {
  const server = http.createServer((request, response) => {
    if (request.url === '/large') { response.end(large); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ hello: 'from the shared device', host: request.headers.host, forwardedHost: request.headers['x-forwarded-host'] || null }));
  });
  server.on('upgrade', (request, socket, head) => { const ws = acceptWebSocket(request, socket, head); ws?.on('message', data => ws.send('echo:' + data)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return listening(server);
}
async function agent(t, options) {
  const mesh = new MeshAgent({ deviceId: deviceId(), deviceName: 'Device', port: 0, lanDiscovery: false, advertise: ['127.0.0.1'], ...options });
  await mesh.start(); t.after(() => mesh.stop());
  return mesh;
}
async function relay(t, options = {}) {
  const server = createRelay({ token, publicDomain: 'tunnels.test', publicScheme: 'http', ...options });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return listening(server);
}
const service = port => ({ id: 'a1b2c3d4e5f60718', name: 'Web app', host: '127.0.0.1', port, protocol: 'http' });
const peerNamed = (mesh, name) => mesh.snapshot().peers.find(peer => peer.name === name);

test('parses shared addresses the way people type them', () => {
  assert.deepEqual(parseTarget('3000'), { host: 'localhost', port: 3000, protocol: 'http', address: 'localhost:3000' });
  assert.deepEqual(parseTarget('192.168.1.20:8080'), { host: '192.168.1.20', port: 8080, protocol: 'http', address: '192.168.1.20:8080' });
  assert.equal(parseTarget('http://0.0.0.0:5173/').host, '127.0.0.1');
  assert.equal(parseTarget('tcp://localhost:5432').protocol, 'tcp');
  assert.equal(parseTarget('http://[::1]:8000').address, '[::1]:8000');
  assert.equal(parseTarget('https://localhost').port, 443);
  for (const bad of ['', 'ftp://host:21', 'localhost:99999', 'http://user:pass@localhost:3000', 'x'.repeat(400)]) assert.throws(() => parseTarget(bad));
});

test('devices connect directly and open each other’s shared addresses on localhost', async t => {
  const large = randomBytes(3 * 1024 * 1024);
  const port = await devServer(t, large), secret = randomBytes(32);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)] });
  const desktop = await agent(t, { secret, deviceName: 'Desktop' });
  // Stands in for a LAN discovery announcement.
  desktop.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await until(() => peerNamed(desktop, 'Laptop')?.services[0]?.localPort && peerNamed(laptop, 'Desktop'));
  const remote = peerNamed(desktop, 'Laptop');
  assert.equal(remote.path, 'direct'); assert.equal(remote.online, true);
  assert.equal(peerNamed(laptop, 'Desktop').path, 'direct');
  // The original port is taken by the real server on this test machine.
  const local = remote.services[0].localPort;
  assert.notEqual(local, port);
  const response = await get(local);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).hello, 'from the shared device');
  assert.equal(sha((await get(local, { path: '/large' })).body), sha(large));
  const ws = await connectWebSocket(`ws://127.0.0.1:${local}/`);
  const reply = new Promise(resolve => ws.once('message', resolve)); ws.send('over the mesh');
  assert.equal(await reply, 'echo:over the mesh'); ws.close();

  // Unsharing removes the forward from the other device.
  laptop.update({ services: [] });
  await until(() => peerNamed(desktop, 'Laptop').services.length === 0);
  await assert.rejects(get(local));
});

test('a stopped shared address returns a readable error page', async t => {
  // Both test devices share one machine. Holding the port on IPv6 loopback
  // keeps the forward off it while IPv4 connections to it are still refused.
  const holder = http.createServer();
  const port = await new Promise(resolve => holder.once('error', () => resolve(null)).listen(0, '::1', () => resolve(holder.address().port)));
  if (!port) return t.skip('IPv6 loopback is unavailable.');
  t.after(() => holder.close());
  const secret = randomBytes(32);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)] });
  const desktop = await agent(t, { secret, deviceName: 'Desktop' });
  desktop.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await until(() => peerNamed(desktop, 'Laptop')?.services[0]?.localPort);
  const response = await get(peerNamed(desktop, 'Laptop').services[0].localPort);
  assert.equal(response.status, 502); assert.match(response.body.toString(), /Nothing answered .* on Laptop/);
});

test('devices from another mesh never see shared addresses', async t => {
  const port = await devServer(t);
  const laptop = await agent(t, { secret: randomBytes(32), deviceName: 'Laptop', services: [service(port)] });
  const stranger = await agent(t, { secret: randomBytes(32), deviceName: 'Stranger' });
  stranger.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(stranger.snapshot().peers, []); assert.deepEqual(laptop.snapshot().peers, []);
});

test('the relay connects devices across networks and serves public URLs', async t => {
  const port = await devServer(t), relayPort = await relay(t), secret = randomBytes(32);
  const relayURL = `ws://127.0.0.1:${relayPort}`;
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)], direct: false, relayURL, relayToken: token });
  const phone = await agent(t, { secret, deviceName: 'Phone', direct: false, relayURL, relayToken: token });
  await until(() => peerNamed(phone, 'Laptop')?.services[0]?.localPort);
  assert.equal(peerNamed(phone, 'Laptop').path, 'relay');
  assert.equal(laptop.relay.status, 'connected'); assert.equal(laptop.relay.publicTunnels, true);
  assert.equal(JSON.parse((await get(peerNamed(phone, 'Laptop').services[0].localPort)).body).hello, 'from the shared device');

  const url = await laptop.expose({ id: 'tunnel-1', name: 'demo', host: '127.0.0.1', port });
  assert.equal(url, 'http://demo.tunnels.test');
  const response = await get(relayPort, { headers: { host: 'demo.tunnels.test' }, path: '/hello?x=1' });
  const body = JSON.parse(response.body);
  // Dev servers that check Host see their own address, as with ngrok's host rewrite.
  assert.equal(body.host, `127.0.0.1:${port}`); assert.equal(body.forwardedHost, 'demo.tunnels.test');
  const ws = await connectWebSocket(`ws://127.0.0.1:${relayPort}/socket`, { headers: { Host: 'demo.tunnels.test' } });
  const reply = new Promise(resolve => ws.once('message', resolve)); ws.send('through the relay');
  assert.equal(await reply, 'echo:through the relay'); ws.close();

  await assert.rejects(phone.expose({ id: 'tunnel-2', name: 'demo', host: '127.0.0.1', port }), /already in use/);
  laptop.unexpose('tunnel-1');
  await until(() => !laptop.exposed.size);
  assert.match((await get(relayPort, { headers: { host: 'demo.tunnels.test' } })).body.toString(), /not active/);
  assert.equal((await get(relayPort)).status, 200);
});

test('the relay refuses wrong access tokens and a mesh without a public domain', async t => {
  const relayPort = await relay(t, { publicDomain: '' });
  const intruder = await agent(t, { secret: randomBytes(32), deviceName: 'Intruder', direct: false, relayURL: `ws://127.0.0.1:${relayPort}`, relayToken: 'wrong-token-wrong-token' });
  await until(() => intruder.relay.status === 'error');
  assert.match(intruder.relay.message, /access token/);
  const member = await agent(t, { secret: randomBytes(32), deviceName: 'Member', direct: false, relayURL: `ws://127.0.0.1:${relayPort}`, relayToken: token });
  await until(() => member.relay.status === 'connected');
  assert.equal(member.relay.publicTunnels, false);
  await assert.rejects(member.expose({ id: 'tunnel-3', host: '127.0.0.1', port: 1 }), /public domain/);
});

test('devices upgrade from the relay to a direct path once they learn each other’s addresses', async t => {
  const relayPort = await relay(t), secret = randomBytes(32), relayURL = `ws://127.0.0.1:${relayPort}`;
  const laptop = await agent(t, { secret, deviceName: 'Laptop', relayURL, relayToken: token });
  const desktop = await agent(t, { secret, deviceName: 'Desktop', relayURL, relayToken: token });
  await until(() => peerNamed(desktop, 'Laptop')?.path === 'direct' && peerNamed(laptop, 'Desktop')?.path === 'direct');
});

// The device with the lower id starts relayed sessions, so test both orders.
for (const [laptopId, desktopId] of [['1'.repeat(32), 'e'.repeat(32)], ['e'.repeat(32), '1'.repeat(32)]]) test(`a device that restarts reconnects through the relay (${laptopId < desktopId ? 'it' : 'its peer'} starts the session)`, async t => {
  const port = await devServer(t), relayPort = await relay(t), secret = randomBytes(32), relayURL = `ws://127.0.0.1:${relayPort}`;
  const options = { secret, direct: false, relayURL, relayToken: token };
  const laptop = await agent(t, { ...options, deviceId: laptopId, deviceName: 'Laptop', services: [service(port)] });
  const first = await agent(t, { ...options, deviceId: desktopId, deviceName: 'Desktop' });
  await until(() => peerNamed(first, 'Laptop')?.online && peerNamed(laptop, 'Desktop')?.online);
  await first.stop();
  await until(() => !peerNamed(laptop, 'Desktop').online);
  const again = await agent(t, { ...options, deviceId: first.deviceId, deviceName: 'Desktop' });
  await until(() => peerNamed(again, 'Laptop')?.services[0]?.localPort && peerNamed(laptop, 'Desktop').online);
  assert.equal(JSON.parse((await get(peerNamed(again, 'Laptop').services[0].localPort)).body).hello, 'from the shared device');
});

test('devices on the same network find each other with signed UDP announcements', async t => {
  const secret = randomBytes(32), ports = [47000 + Math.floor(Math.random() * 1000), 48000 + Math.floor(Math.random() * 1000)];
  const options = index => ({ secret, lanDiscovery: true, discoveryPort: ports[index], discoveryTargets: [{ address: '127.0.0.1', port: ports[1 - index] }] });
  const laptop = await agent(t, { ...options(0), deviceName: 'Laptop' });
  const desktop = await agent(t, { ...options(1), deviceName: 'Desktop' });
  await until(() => peerNamed(desktop, 'Laptop')?.path === 'direct' && peerNamed(laptop, 'Desktop')?.path === 'direct');
});

// Hostile input: none of these may crash a device or the relay.
const raw = (port, text) => new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', () => socket.write(text)); let data = ''; socket.on('data', part => { data += part; }); socket.on('close', () => resolve(data)); socket.on('error', reject); setTimeout(() => socket.destroy(), 1000); });

test('the relay survives request targets that are not valid URLs', async t => {
  const relayPort = await relay(t);
  assert.match(await raw(relayPort, 'GET http://a:b/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1.1 400/);
  assert.match(await raw(relayPort, 'GET http://a:b/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /^HTTP\/1.1 400/);
  assert.equal((await get(relayPort)).status, 200);
});

test('a device survives a hostile relay and caps what it can make the device do', async t => {
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) => {
    const ws = acceptWebSocket(request, socket, head);
    ws.send(JSON.stringify({ type: 'welcome', peers: [], publicTunnels: false }));
    for (const message of ['null', '"text"', '[]', '{"type":"joined","peer":null}']) ws.send(message);
    for (let index = 0; index < 500; index++) ws.send(JSON.stringify({ type: 'joined', peer: 'f'.repeat(28) + index.toString(16).padStart(4, '0') }));
    // Malformed frames arrive later: the device drops the connection, not the process.
    setTimeout(() => { ws.send(Buffer.from([1, ...randomBytes(16), 1, 2, 3])); ws.send(Buffer.from([9, 9])); ws.send(Buffer.from([2])); }, 300);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = await listening(server);
  const mesh = await agent(t, { secret: randomBytes(32), deviceId: '0'.repeat(32), direct: false, relayURL: `ws://127.0.0.1:${port}`, relayToken: token });
  await until(() => mesh.relayPeers.size === 64);
  await new Promise(resolve => setTimeout(resolve, 100));
  // This device starts sessions with every higher id, but only with 64 of them.
  assert.equal(mesh.relayPeers.size, 64); assert.equal(mesh.relayChannels.size, 64);
  await until(() => mesh.relay.status !== 'connected');
  // Catalog addresses that are not real IPv4 endpoints are ignored, never dialled.
  assert.doesNotThrow(() => { mesh.candidate('a'.repeat(32), '10.0.0.1:99999'); mesh.candidate('a'.repeat(32), '300.0.0.1:80'); });
  assert.equal(mesh.candidates.has('a'.repeat(32)), false);
});

test('fresh LAN announcements displace stale or replayed addresses', async t => {
  const mesh = await agent(t, { secret: randomBytes(32), direct: false });
  const peer = 'b'.repeat(32);
  for (let index = 1; index <= 20; index++) mesh.candidate(peer, `10.9.0.${index}:47820`);
  mesh.candidate(peer, '192.168.1.5:47820');
  const known = [...mesh.candidates.get(peer).keys()];
  assert.equal(known.length, 16); assert.equal(known.at(-1), '192.168.1.5:47820'); assert.equal(known.includes('10.9.0.1:47820'), false);
});

test('WebSocket peers cannot grow memory with empty fragments', async t => {
  const server = net.createServer(socket => {
    const { WebSocketConnection } = websocket;
    const ws = new WebSocketConnection(socket);
    ws.on('close', code => server.emit('closed', code));
  });
  t.after(() => server.close());
  const port = await listening(server);
  const closed = new Promise(resolve => server.once('closed', resolve));
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const frame = opcode => Buffer.from([opcode, 0x80, 0, 0, 0, 0]);
  socket.write(Buffer.concat([frame(0x01), ...Array.from({ length: 1100 }, () => frame(0x00))]));
  assert.equal(await closed, 1009);
  socket.destroy();
});

test('public URL names stay with their mesh while its device reconnects', async t => {
  const port = await devServer(t), relayPort = await relay(t), relayURL = `ws://127.0.0.1:${relayPort}`, secret = randomBytes(32);
  const owner = await agent(t, { secret, deviceName: 'Owner', direct: false, relayURL, relayToken: token });
  await until(() => owner.relay.status === 'connected');
  await owner.expose({ id: 'own', name: 'shop', host: '127.0.0.1', port });
  await owner.stop();
  const other = await agent(t, { secret: randomBytes(32), deviceName: 'Other mesh', direct: false, relayURL, relayToken: token });
  await until(() => other.relay.status === 'connected');
  await assert.rejects(other.expose({ id: 'steal', name: 'shop', host: '127.0.0.1', port }), /already in use/);
  const back = await agent(t, { secret, deviceId: owner.deviceId, deviceName: 'Owner', direct: false, relayURL, relayToken: token });
  await until(() => back.relay.status === 'connected');
  assert.equal(await back.expose({ id: 'own', name: 'shop', host: '127.0.0.1', port }), 'http://shop.tunnels.test');
});

test('device connections never route to a public URL, whatever the domain layout', async t => {
  const port = await devServer(t), relayPort = await relay(t, { publicDomain: 'example.test' }), secret = randomBytes(32);
  const first = await agent(t, { secret, deviceName: 'First', direct: false, relayURL: `ws://127.0.0.1:${relayPort}`, relayToken: token });
  await until(() => first.relay.status === 'connected');
  await first.expose({ id: 'collide', name: 'relay', host: '127.0.0.1', port });
  // A second device reaches the relay at the host name the tunnel now owns.
  const second = await connectWebSocket(`ws://127.0.0.1:${relayPort}/_dropovpn/v1/agent`, { headers: { Host: 'relay.example.test', Authorization: `Bearer ${token}`, 'X-DropoVPN-Mesh': first.keys.id, 'X-DropoVPN-Device': deviceId() } });
  const welcome = await new Promise(resolve => second.once('message', resolve));
  assert.equal(JSON.parse(welcome).type, 'welcome'); second.close();
});

test('the relay limits connections per address and paces devices that exceed their budget', async t => {
  const relayPort = await relay(t, { maxPerAddress: 2, deviceRate: 64 * 1024, clientAddressHeader: 'fly-client-ip' });
  const connect = (address, mesh = 'c'.repeat(32), device = deviceId()) => connectWebSocket(`ws://127.0.0.1:${relayPort}/_dropovpn/v1/agent`, { headers: { Authorization: `Bearer ${token}`, 'X-DropoVPN-Mesh': mesh, 'X-DropoVPN-Device': device, 'Fly-Client-IP': address } });
  const sockets = [await connect('203.0.113.7'), await connect('203.0.113.7')];
  await assert.rejects(connect('203.0.113.7'), error => error.status === 429);
  sockets.push(await connect('198.51.100.9'));
  // Peer traffic above 64 KB/s is slowed down rather than discarded.
  const receiverId = deviceId(), receiver = await connect('198.51.100.10', 'd'.repeat(32), receiverId);
  let received = 0; receiver.on('message', (data, binary) => { if (binary) received += data.length; });
  const sender = await connect('198.51.100.11', 'd'.repeat(32));
  sockets.push(receiver, sender);
  const start = Date.now();
  for (let index = 0; index < 8; index++) sender.send(Buffer.concat([Buffer.from([1]), Buffer.from(receiverId, 'hex'), randomBytes(32 * 1024)]));
  await until(() => received >= 8 * (32 * 1024 + 17), 10000);
  // One second of burst plus at most one 64 KB read before the pause; the rest is paced.
  assert.ok(Date.now() - start >= 1800, `256 KB at 64 KB/s arrived in ${Date.now() - start} ms`);
  for (const ws of sockets) ws.close();
});

test('a device that drops briefly keeps its addresses, and new requests wait for it to come back', async t => {
  const port = await devServer(t), secret = randomBytes(32);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)] });
  const desktop = await agent(t, { secret, deviceName: 'Desktop' });
  desktop.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await until(() => peerNamed(desktop, 'Laptop')?.services[0]?.localPort);
  const local = peerNamed(desktop, 'Laptop').services[0].localPort;
  desktop.peers.get(laptop.deviceId).direct.mux.close(new Error('The network changed.'));
  await until(() => peerNamed(desktop, 'Laptop').reconnecting);
  assert.equal(peerNamed(desktop, 'Laptop').online, false);
  assert.equal(peerNamed(desktop, 'Laptop').services[0].localPort, local);
  const pending = get(local);
  await new Promise(resolve => setTimeout(resolve, 150));
  desktop.refresh();
  assert.equal(JSON.parse((await pending).body).hello, 'from the shared device');
  await until(() => peerNamed(desktop, 'Laptop').online);
  assert.equal(peerNamed(desktop, 'Laptop').reconnecting, false);
});

test('a device that stays away goes offline after the grace period', async t => {
  const port = await devServer(t), secret = randomBytes(32);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)] });
  const desktop = await agent(t, { secret, deviceName: 'Desktop', grace: 300 });
  desktop.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await until(() => peerNamed(desktop, 'Laptop')?.services[0]?.localPort);
  const local = peerNamed(desktop, 'Laptop').services[0].localPort;
  // The laptop vanishes without saying goodbye, as when its network drops.
  laptop.stopped = true; desktop.peers.get(laptop.deviceId).direct.mux.close(new Error('The network dropped.'));
  await until(() => peerNamed(desktop, 'Laptop').reconnecting);
  await until(() => !peerNamed(desktop, 'Laptop').reconnecting && !peerNamed(desktop, 'Laptop').online);
  await until(() => !peerNamed(desktop, 'Laptop').services[0].localPort);
  await assert.rejects(get(local));
});

test('waking up replaces connections that went quiet instead of waiting for keepalives', async t => {
  const secret = randomBytes(32), relayPort = await relay(t);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', relayURL: `ws://127.0.0.1:${relayPort}`, relayToken: token });
  const desktop = await agent(t, { secret, deviceName: 'Desktop', relayURL: `ws://127.0.0.1:${relayPort}`, relayToken: token });
  await until(() => peerNamed(desktop, 'Laptop')?.path === 'direct' && desktop.relay.status === 'connected');
  const peer = desktop.peers.get(laptop.deviceId), session = peer.direct, socket = desktop.relaySocket;
  // As if the computer slept: nothing has arrived for a minute.
  session.mux.lastSeen = Date.now() - 60000; socket.lastReceived = Date.now() - 60000;
  desktop.refresh();
  assert.equal(session.mux.closed, true);
  await until(() => peer.direct && peer.direct !== session && desktop.relaySocket && desktop.relaySocket !== socket && desktop.relay.status === 'connected');
});

test('a device that leaves on purpose goes offline at once', async t => {
  const port = await devServer(t), secret = randomBytes(32);
  const laptop = await agent(t, { secret, deviceName: 'Laptop', services: [service(port)] });
  const desktop = await agent(t, { secret, deviceName: 'Desktop' });
  desktop.candidate(laptop.deviceId, `127.0.0.1:${laptop.listenPort}`);
  await until(() => peerNamed(desktop, 'Laptop')?.services[0]?.localPort);
  await laptop.stop();
  await until(() => !peerNamed(desktop, 'Laptop').online);
  assert.equal(peerNamed(desktop, 'Laptop').reconnecting, false);
});
