import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Mux, splice } from './mux.mjs';
import { SecureChannel, discoveryPacket, isDeviceId, meshKeys, readDiscovery } from './meshcrypto.mjs';
import { connectWebSocket } from './websocket.mjs';

export const MESH_PORT = 47820, DISCOVERY_PORT = 47821, MAX_SERVICES = 32, GRACE = 30000, STALE = 20000;
const MAX_FRAME = 256 * 1024, MAX_PEERS = 64, RELAY_PEER = 1, RELAY_TUNNEL = 2;
const hostPort = (host, port) => `${host.includes(':') ? `[${host}]` : host}:${port}`;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '';
const ipv4 = address => address.split('.').reduce((value, part) => (value << 8 | Number(part)) >>> 0, 0);
const dotted = value => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
const listen = (server, port, host) => new Promise((resolve, reject) => {
  const fail = error => { server.off('listening', done); reject(error); };
  const done = () => { server.off('error', fail); resolve(server.address().port); };
  server.once('error', fail); server.once('listening', done); server.listen(port, host);
});
// Something already answering on either loopback address owns that port.
export const inUse = port => Promise.all(['127.0.0.1', '::1'].map(host => new Promise(resolve => {
  const socket = net.connect({ host, port });
  socket.setTimeout(400, () => { socket.destroy(); resolve(false); });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
}))).then(results => results.some(Boolean));

// Accepts "3000", "localhost:3000", "http://192.168.1.20:8080" or "tcp://localhost:5432".
export function parseTarget(value) {
  const invalid = () => new Error('Enter a local address such as 3000, localhost:3000 or http://localhost:3000.');
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw invalid();
  let address = value.trim();
  if (/^\d+$/.test(address)) address = 'localhost:' + address;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) address = 'http://' + address;
  let url; try { url = new URL(address); } catch { throw invalid(); }
  const protocol = url.protocol.slice(0, -1);
  if (!['http', 'https', 'tcp'].includes(protocol) || url.username || url.password) throw invalid();
  const port = Number(url.port || { http: 80, https: 443 }[protocol]);
  let host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  if (host === '0.0.0.0') host = '127.0.0.1'; else if (host === '::') host = '::1';
  return { host, port, protocol, address: hostPort(host, port) };
}

const validAddress = address => {
  const match = typeof address === 'string' && address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/);
  return !!match && match.slice(1, 5).every(octet => Number(octet) <= 255) && Number(match[5]) >= 1 && Number(match[5]) <= 65535;
};
function cleanCatalog(value) {
  const ids = new Set();
  const services = (Array.isArray(value.services) ? value.services : []).slice(0, MAX_SERVICES).filter(service =>
    service && typeof service.id === 'string' && /^[a-f0-9]{16}$/.test(service.id) && !ids.has(service.id) && ids.add(service.id) && Number.isInteger(service.port) && service.port > 0 && service.port < 65536
  ).map(service => ({ id: service.id, name: text(service.name, 64) || `Port ${service.port}`, port: service.port, protocol: ['http', 'https', 'tcp'].includes(service.protocol) ? service.protocol : 'tcp' }));
  const addresses = (Array.isArray(value.addresses) ? value.addresses : []).slice(0, 16).filter(validAddress);
  return { name: text(value.name, 64) || 'Unnamed device', platform: text(value.platform, 16), services, addresses };
}

// When a shared address is not running, answer browsers with a readable page
// instead of a bare connection reset.
function connectTarget(stream, { host, port, protocol }, unavailable) {
  const socket = net.connect({ host, port });
  let connected = false;
  socket.once('connect', () => { connected = true; socket.setNoDelay(true); splice(stream, socket); });
  socket.on('error', error => {
    if (connected) return;
    if (protocol !== 'http') { stream.destroy(error); return; }
    const body = unavailable + '\n';
    stream.resume(); stream.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  stream.on('error', () => { if (!connected) socket.destroy(); });
}

export class MeshAgent extends EventEmitter {
  constructor({ secret, deviceId, deviceName, services = [], relayURL = '', relayToken = '', lanDiscovery = true, direct = true, host = '0.0.0.0', port = MESH_PORT, discoveryPort = DISCOVERY_PORT, advertise = null, discoveryTargets = null, grace = GRACE, version = '', log = () => {} }) {
    super();
    Object.assign(this, { deviceId, deviceName, services, relayURL, relayToken, lanDiscovery, direct, host, preferredPort: port, discoveryPort, advertise, discoveryTargets, grace, version, log });
    this.keys = meshKeys(secret); this.peers = new Map(); this.candidates = new Map(); this.dialing = new Set(); this.lastDial = new Map(); this.assigned = new Map(); this.serving = new Map();
    this.relayChannels = new Map(); this.relayPeers = new Set(); this.relayStarted = new Map(); this.relayRetry = new Map(); this.exposed = new Map(); this.relayAttempts = 0; this.pending = 0; this.pendingFrom = new Map();
    this.relay = { status: relayURL ? 'connecting' : 'off', message: relayURL ? 'Connecting to your relay…' : '', publicTunnels: false };
    this.listenPort = null; this.listenError = ''; this.stopped = false;
  }
  async start() {
    if (this.direct) {
      this.server = net.createServer(socket => {
        // Unfinished handshakes are limited overall and per address.
        if (this.stopped || this.pending >= 64 || (this.pendingFrom.get(socket.remoteAddress) || 0) >= 4) socket.destroy(); else this.secure(socket, false);
      });
      for (const port of [this.preferredPort, 0]) {
        try { this.listenPort = await listen(this.server, port, this.host); this.listenError = ''; break; } catch (error) { this.listenError = error.message; }
      }
      this.server.on('error', () => {});
      if (this.lanDiscovery) this.discover();
    }
    if (this.relayURL) void this.connectRelay();
    this.timer = setInterval(() => this.maintain(), 10000); this.timer.unref?.();
    this.maintain();
  }
  async stop() {
    // Say goodbye first, so other devices know this is not a brief drop.
    if (!this.stopped) { for (const peer of this.peers.values()) for (const session of [peer.direct, peer.relay]) session?.mux.message({ type: 'bye' }); await new Promise(resolve => setTimeout(resolve, 50)); }
    this.stopped = true; clearInterval(this.timer); clearInterval(this.announceTimer); clearTimeout(this.relayTimer);
    for (const timer of this.relayRetry.values()) clearTimeout(timer);
    try { this.udp?.close(); } catch { /* Already closed. */ }
    this.server?.close(); this.relaySocket?.close(1001, 'The mesh stopped on this device.'); this.relayMux?.close();
    for (const channel of this.relayChannels.values()) channel.close('The mesh stopped.');
    for (const peer of this.peers.values()) {
      clearTimeout(peer.graceTimer);
      for (const waiter of peer.waiters) waiter.socket.destroy();
      peer.direct?.mux.close(); peer.relay?.mux.close();
      for (const forward of peer.forwards.values()) forward.server.close();
      peer.forwards.clear();
    }
    for (const tunnel of this.exposed.values()) tunnel.reject?.(new Error('The mesh stopped.'));
    this.exposed.clear();
  }
  update({ deviceName, services }) {
    if (deviceName !== undefined) this.deviceName = deviceName;
    if (services !== undefined) {
      this.services = services;
      for (const [id, streams] of this.serving) if (!services.some(service => service.id === id)) { for (const stream of streams) stream.destroy(new Error('That address is no longer shared.')); this.serving.delete(id); }
    }
    this.broadcast(); this.emit('change');
  }
  catalog() {
    const addresses = this.listenPort ? this.addresses().map(address => `${address}:${this.listenPort}`) : [];
    return { type: 'catalog', name: this.deviceName, platform: process.platform, services: this.services.map(({ id, name, port, protocol }) => ({ id, name, port, protocol })), addresses };
  }
  addresses() {
    if (this.advertise) return this.advertise;
    return Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')).map(item => item.address).slice(0, 12);
  }
  broadcast() { const catalog = this.catalog(); for (const peer of this.peers.values()) for (const session of [peer.direct, peer.relay]) session?.mux.message(catalog); }
  snapshot() {
    return {
      deviceId: this.deviceId, port: this.listenPort, listenError: this.listenError, relay: { ...this.relay },
      peers: [...this.peers.values()].filter(peer => peer.known).map(peer => ({
        id: peer.id, name: peer.name, platform: peer.platform, online: !!(peer.direct || peer.relay), reconnecting: peer.state === 'reconnecting', path: peer.direct ? 'direct' : peer.relay ? 'relay' : null, lastSeen: peer.lastSeen,
        services: peer.services.map(service => ({ ...service, localPort: peer.forwards.get(service.id)?.port ?? null, error: peer.forwards.get(service.id)?.error || '' }))
      }))
    };
  }
  forwardPorts() { return [...this.peers.values()].flatMap(peer => [...peer.forwards.values()].map(forward => forward.port).filter(Boolean)); }

  // Sessions. Each peer has at most one direct and one relayed session; new
  // connections prefer the direct path.
  peer(id) {
    let peer = this.peers.get(id);
    if (!peer && this.peers.size < MAX_PEERS) this.peers.set(id, peer = { id, name: '', platform: '', services: [], direct: null, relay: null, forwards: new Map(), waiters: [], known: false, state: 'offline', online: false, lastOnline: 0, graceTimer: null, lastSeen: null });
    return peer;
  }
  attach(kind, channel, initiatorId) {
    const peer = this.peer(channel.peerId);
    if (this.stopped || !peer) { channel.close('This device cannot accept more peers.'); return; }
    const existing = peer[kind];
    // If both devices dial at once, both keep the session the lower id started.
    if (existing && existing.initiatorId !== initiatorId && existing.initiatorId < initiatorId) { channel.close('Duplicate session.'); return; }
    const mux = new Mux({ send: frame => channel.write(frame), initiator: initiatorId === this.deviceId });
    const session = { kind, channel, mux, initiatorId };
    peer.departed = false;
    peer[kind] = session; existing?.mux.close();
    channel.on('record', record => mux.receive(record));
    channel.on('close', () => mux.close());
    mux.on('close', () => { channel.close(); if (peer[kind] === session) { peer[kind] = null; this.sync(peer); } });
    mux.on('message', message => this.catalogReceived(peer, message));
    mux.on('stream', (stream, meta) => {
      const service = this.services.find(item => item.id === meta.service);
      if (!service) { stream.destroy(new Error('That address is no longer shared.')); return; }
      const open = this.serving.get(service.id) || new Set(); open.add(stream); this.serving.set(service.id, open);
      stream.once('close', () => open.delete(stream));
      connectTarget(stream, service, `Nothing answered at ${hostPort(service.host, service.port)} on ${this.deviceName}. Start it there, then reload this page.`);
    });
    mux.message(this.catalog()); this.sync(peer);
  }
  catalogReceived(peer, message) {
    if (message?.type === 'bye') { peer.departed = true; return; }
    if (message?.type !== 'catalog') return;
    Object.assign(peer, cleanCatalog(message), { known: true, lastSeen: new Date().toISOString() });
    for (const address of peer.addresses) this.candidate(peer.id, address);
    this.sync(peer);
  }
  sync(peer) {
    const online = !!(peer.direct || peer.relay), path = peer.direct ? 'directly' : 'through your relay';
    if (online) { peer.lastOnline = Date.now(); clearTimeout(peer.graceTimer); peer.graceTimer = null; }
    // A device that drops briefly (a relay reconnect, a computer waking up)
    // keeps its forwarded ports for a grace period, so its addresses keep
    // working and new connections wait for it instead of failing.
    const grace = !online && peer.known && !this.stopped && !peer.departed && Date.now() - peer.lastOnline < this.grace;
    if (grace && !peer.graceTimer) { peer.graceTimer = setTimeout(() => { peer.graceTimer = null; this.sync(peer); }, this.grace - (Date.now() - peer.lastOnline) + 50); peer.graceTimer.unref?.(); }
    const state = online ? 'online' : grace ? 'reconnecting' : 'offline';
    if (peer.known && state !== peer.state && state !== 'reconnecting' && !(state === 'online' && peer.state === 'reconnecting')) this.log(state === 'online' ? `${peer.name} is connected ${path}.` : `${peer.name} went offline.`, state === 'online' ? 'info' : 'warning');
    peer.state = state; peer.online = online;
    if (online) this.release(peer);
    else if (!grace) for (const waiter of peer.waiters.splice(0)) waiter.socket.destroy();
    const wanted = (online || grace) && peer.known && !this.stopped ? peer.services : [];
    for (const [id, forward] of peer.forwards) if (!wanted.some(service => service.id === id)) { forward.server.close(); peer.forwards.delete(id); }
    for (const service of wanted) if (!peer.forwards.has(service.id)) void this.forward(peer, service);
    this.emit('change');
  }
  // Make a peer's shared address reachable on this device's loopback,
  // preferring the same port it uses on the device that shares it.
  async forward(peer, service) {
    const key = `${peer.id}/${service.id}`, forward = { server: null, port: null, error: '' };
    forward.server = net.createServer(socket => {
      if (peer.direct || peer.relay) { this.connect(peer, service, socket); return; }
      if (peer.state !== 'reconnecting') { socket.destroy(); return; }
      // Hold the connection until the device is back; data it sends waits in the socket.
      const waiter = { socket, service, timer: setTimeout(() => socket.destroy(), 15000) };
      peer.waiters.push(waiter);
      socket.once('close', () => { clearTimeout(waiter.timer); peer.waiters = peer.waiters.filter(item => item !== waiter); });
    });
    forward.server.on('error', () => {});
    peer.forwards.set(service.id, forward);
    for (const port of [...new Set([service.port, this.assigned.get(key), 0])].filter(port => port !== undefined)) {
      if (port && await inUse(port)) continue;
      if (peer.forwards.get(service.id) !== forward) break;
      try { forward.port = await listen(forward.server, port, '127.0.0.1'); break; } catch { /* Try the next port. */ }
    }
    if (peer.forwards.get(service.id) !== forward || this.stopped) { forward.server.close(); return; }
    if (forward.port) this.assigned.set(key, forward.port); else forward.error = 'No local port is available.';
    this.emit('change');
  }

  connect(peer, service, socket) {
    const session = peer.direct || peer.relay;
    let stream; try { stream = session.mux.open({ service: service.id }); } catch { socket.destroy(); return; }
    socket.setNoDelay(true); splice(socket, stream);
  }
  release(peer) {
    for (const waiter of peer.waiters.splice(0)) { clearTimeout(waiter.timer); if (!waiter.socket.destroyed && peer.forwards.has(waiter.service.id)) this.connect(peer, waiter.service, waiter.socket); else waiter.socket.destroy(); }
  }
  // After sleep or a network change, connections that have gone quiet are
  // usually dead. Replace them now instead of waiting for keepalives to notice.
  refresh() {
    if (this.stopped) return;
    const now = Date.now();
    this.lastDial.clear();
    for (const peer of this.peers.values()) for (const session of [peer.direct, peer.relay]) if (session && now - session.mux.lastSeen > STALE) session.mux.close(new Error('The connection went quiet.'));
    if (this.relaySocket && now - this.relaySocket.lastReceived > STALE) this.relaySocket.close(4001, 'Reconnecting after sleep or a network change.');
    else if (!this.relaySocket && this.relayURL) { clearTimeout(this.relayTimer); this.relayAttempts = 0; void this.connectRelay(); }
    this.maintain();
  }

  // Direct connections: TCP with length-prefixed handshake and record messages.
  secure(socket, initiator, opened = () => {}) {
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000); socket.on('error', () => {});
    const address = socket.remoteAddress || '';
    const channel = new SecureChannel({ keys: this.keys, deviceId: this.deviceId, initiator, timeout: initiator ? 10000 : 5000, send: message => {
      // A peer that stops reading is disconnected rather than buffered without limit.
      if (socket.writableLength > 16 * 1024 * 1024) { socket.destroy(); return; }
      const header = Buffer.allocUnsafe(4); header.writeUInt32BE(message.length); socket.write(Buffer.concat([header, message]));
    } });
    let parts = [], size = 0, need = 4, waiting = true;
    const settle = () => {
      if (!waiting) return;
      waiting = false; this.pending--;
      const left = (this.pendingFrom.get(address) || 1) - 1;
      if (left) this.pendingFrom.set(address, left); else this.pendingFrom.delete(address);
    };
    this.pending++; this.pendingFrom.set(address, (this.pendingFrom.get(address) || 0) + 1);
    socket.on('data', chunk => {
      // Chunks are joined only once a whole frame has arrived.
      parts.push(chunk); size += chunk.length;
      if (size < need) return;
      let buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
      need = 4;
      while (buffer.length >= 4 && !channel.closed) {
        const length = buffer.readUInt32BE(0);
        // Until the peer proves it holds the mesh key, frames stay small.
        if (length > (channel.open ? MAX_FRAME : 32 * 1024)) { socket.destroy(); return; }
        if (buffer.length < 4 + length) { need = 4 + length; break; }
        const message = buffer.subarray(4, 4 + length); buffer = buffer.subarray(4 + length);
        channel.receive(message);
      }
      parts = buffer.length ? [buffer] : []; size = buffer.length;
    });
    channel.on('open', peerId => { settle(); opened(peerId); this.attach('direct', channel, initiator ? this.deviceId : peerId); });
    channel.on('close', () => { settle(); socket.destroy(); });
    socket.on('close', () => { settle(); channel.close('The connection closed.'); });
    channel.start();
  }
  candidate(peerId, address) {
    if (peerId === this.deviceId || !validAddress(address)) return;
    // The freshest addresses stay; the stalest makes room when the list is full.
    const known = this.candidates.get(peerId) || new Map(), failures = known.get(address) || 0;
    known.delete(address); known.set(address, failures);
    while (known.size > 16) known.delete(known.keys().next().value);
    this.candidates.delete(peerId); this.candidates.set(peerId, known);
    while (this.candidates.size > MAX_PEERS * 2) this.candidates.delete(this.candidates.keys().next().value);
    if (!this.peers.get(peerId)?.direct) this.dial(peerId, address);
  }
  dial(peerId, address) {
    // One attempt per device at a time, so two paths to it never race.
    if (this.stopped || !this.direct || this.dialing.has(peerId) || Date.now() - (this.lastDial.get(address) || 0) < 20000) return;
    const split = address.lastIndexOf(':');
    let socket, connected = false;
    try { socket = net.connect({ host: address.slice(0, split), port: Number(address.slice(split + 1)), timeout: 4000 }); } catch { this.failed(peerId, address); return; }
    this.dialing.add(peerId); this.lastDial.set(address, Date.now());
    const done = () => this.dialing.delete(peerId);
    socket.once('timeout', () => socket.destroy());
    socket.once('error', () => {});
    socket.once('close', () => { done(); if (!connected) this.failed(peerId, address); });
    socket.once('connect', () => { socket.setTimeout(0); this.secure(socket, true, () => { connected = true; done(); this.candidates.get(peerId)?.set(address, 0); }); });
  }
  failed(peerId, address) {
    const known = this.candidates.get(peerId);
    if (!known?.has(address)) return;
    // Addresses that keep failing, such as replayed announcements, are dropped.
    const failures = known.get(address) + 1;
    if (failures >= 3) known.delete(address); else known.set(address, failures);
  }
  discover() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true }); this.udp = udp;
    udp.on('error', error => {
      this.log(`Local network discovery is unavailable: ${error.message}`, 'warning');
      try { udp.close(); } catch { /* Already closed. */ }
      if (this.udp === udp) this.udp = null;
    });
    udp.on('message', (packet, info) => {
      const found = readDiscovery(this.keys, packet);
      if (found && found.deviceId !== this.deviceId) this.candidate(found.deviceId, `${info.address}:${found.port}`);
    });
    udp.bind(this.discoveryPort, () => {
      udp.setBroadcast(true);
      const announce = () => {
        if (!this.listenPort || this.stopped) return;
        const packet = discoveryPacket(this.keys, this.deviceId, this.listenPort);
        for (const { address, port } of this.discoveryTargets || this.broadcastTargets()) udp.send(packet, port, address, () => {});
      };
      announce(); this.announceTimer = setInterval(announce, 5000); this.announceTimer.unref?.();
    });
  }
  broadcastTargets() {
    const targets = new Set();
    for (const item of Object.values(os.networkInterfaces()).flat()) {
      if (item?.family !== 'IPv4' || item.internal || item.netmask === '255.255.255.255') continue;
      targets.add(dotted((ipv4(item.address) | ~ipv4(item.netmask)) >>> 0));
    }
    return [...targets].map(address => ({ address, port: this.discoveryPort }));
  }
  maintain() {
    if (this.stopped) return;
    const addresses = JSON.stringify(this.catalog().addresses);
    const changed = this.lastAddresses !== undefined && addresses !== this.lastAddresses;
    this.lastAddresses = addresses;
    // A new network: tell peers where to find this device and start fresh connections.
    if (changed) { this.broadcast(); this.refresh(); return; }
    for (const [peerId, known] of [...this.candidates]) if (!this.peers.get(peerId)?.direct) for (const address of [...known.keys()]) this.dial(peerId, address);
    for (const [address, time] of this.lastDial) if (Date.now() - time > 60000) this.lastDial.delete(address);
    for (const peerId of this.relayPeers) this.ensureRelay(peerId);
  }

  // Relay: a WebSocket that carries end-to-end encrypted peer messages and,
  // separately, plaintext public-URL streams that the relay itself serves.
  setRelay(patch) { Object.assign(this.relay, patch); this.emit('change'); }
  async connectRelay() {
    if (this.stopped || this.relaySocket) return;
    this.setRelay({ status: 'connecting', message: 'Connecting to your relay…' });
    let socket;
    try {
      const base = this.relayURL.endsWith('/') ? this.relayURL : this.relayURL + '/';
      socket = await connectWebSocket(new URL('_dropovpn/v1/agent', base).href, { maxMessage: 512 * 1024, headers: { Authorization: `Bearer ${this.relayToken}`, 'X-DropoVPN-Mesh': this.keys.id, 'X-DropoVPN-Device': this.deviceId, 'X-DropoVPN-Client': `${process.platform} ${this.version || ''}`.trim() } });
    } catch (error) {
      if (this.stopped) return;
      this.setRelay({ status: 'error', publicTunnels: false, message: error.status === 401 ? 'The relay did not accept this mesh’s access token.' : error.status ? 'That address did not answer like a DropoVPN relay.' : `The relay is unreachable: ${error.message}` });
      this.retryRelay(); return;
    }
    if (this.stopped) { socket.close(); return; }
    this.relaySocket = socket; this.relayAttempts = 0;
    const mux = this.relayMux = new Mux({ send: frame => socket.send(Buffer.concat([Buffer.from([RELAY_TUNNEL]), frame])), initiator: false });
    mux.on('stream', (stream, meta) => {
      const tunnel = this.exposed.get(meta.tunnel);
      // Public visitors see a generic page: no device name or internal address.
      if (tunnel) connectTarget(stream, { ...tunnel, protocol: 'http' }, 'The app behind this URL is not running right now. Try again in a moment.'); else stream.destroy(new Error('That public URL has stopped.'));
    });
    mux.on('close', error => socket.close(4000, String(error?.message || 'Closed.').slice(0, 100)));
    // The relay is not trusted with more than dropping traffic, so nothing it
    // sends may throw out of the socket handler.
    socket.on('message', (data, binary) => { try { if (binary) this.relayBinary(data); else this.relayText(data); } catch { /* Ignore malformed relay messages. */ } });
    socket.on('close', (code, reason) => {
      if (this.relaySocket !== socket) return;
      if (!this.stopped) this.log(`Lost the connection to the relay${reason ? ` (${reason})` : ''}. Reconnecting…`, 'warning');
      this.relaySocket = null; this.relayReady = false; mux.close(); this.relayPeers.clear(); this.relayStarted.clear();
      for (const timer of this.relayRetry.values()) clearTimeout(timer);
      this.relayRetry.clear();
      for (const channel of this.relayChannels.values()) channel.close('The relay connection closed.');
      this.relayChannels.clear();
      for (const tunnel of this.exposed.values()) tunnel.online = false;
      if (this.stopped) return;
      this.setRelay({ status: 'connecting', publicTunnels: false, message: code === 4409 ? 'Another copy of this device connected to the relay.' : 'Reconnecting to your relay…' });
      this.retryRelay();
    });
  }
  retryRelay() {
    const delay = Math.min(30000, 1000 * 2 ** this.relayAttempts++);
    this.relayTimer = setTimeout(() => void this.connectRelay(), delay); this.relayTimer.unref?.();
  }
  relayText(data) {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const peer = isDeviceId(message.peer) && message.peer !== this.deviceId ? message.peer : null;
    if (message.type === 'welcome') {
      this.relayReady = true;
      for (const id of Array.isArray(message.peers) ? message.peers.slice(0, MAX_PEERS) : []) if (isDeviceId(id) && id !== this.deviceId) this.relayPeers.add(id);
      this.setRelay({ status: 'connected', message: 'Connected to your relay.', publicTunnels: message.publicTunnels === true });
      for (const id of this.relayPeers) this.ensureRelay(id);
      for (const tunnel of this.exposed.values()) this.requestTunnel(tunnel);
    } else if (message.type === 'joined' && peer && (this.relayPeers.has(peer) || this.relayPeers.size < MAX_PEERS)) {
      this.relayPeers.add(peer);
      // The lower id always starts relayed sessions; a rejoin means the old one is stale.
      if (this.deviceId < peer) { this.relayChannels.get(peer)?.close('The device reconnected.'); this.ensureRelay(peer); }
    } else if (message.type === 'left' && peer) {
      this.relayPeers.delete(peer); this.relayChannels.get(peer)?.close('The device left the relay.');
    } else if ((message.type === 'tunnel' || message.type === 'tunnel-error') && this.exposed.has(message.id)) {
      const tunnel = this.exposed.get(message.id);
      if (message.type === 'tunnel' && typeof message.url === 'string' && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(message.url)) {
        Object.assign(tunnel, { url: message.url, name: text(message.name, 63), online: true, error: '' }); tunnel.resolve?.(message.url);
      } else {
        tunnel.error = text(message.error, 200) || 'The relay refused this public URL.'; tunnel.online = false; tunnel.reject?.(new Error(tunnel.error));
        if (!tunnel.url) this.exposed.delete(message.id);
      }
      tunnel.resolve = tunnel.reject = null; this.emit('change');
    }
  }
  relayBinary(data) {
    if (data[0] === RELAY_TUNNEL) { this.relayMux?.receive(data.subarray(1)); return; }
    if (data[0] !== RELAY_PEER || data.length < 18) return;
    const from = data.subarray(1, 17).toString('hex'), payload = data.subarray(17);
    if (from === this.deviceId) return;
    if (payload[0] === 1) {
      if (from > this.deviceId || !this.relayPeers.has(from)) return;
      this.relayChannels.get(from)?.close('The device started a new session.');
      this.relayChannel(from, false).receive(payload);
    } else this.relayChannels.get(from)?.receive(payload);
  }
  relayChannel(peerId, initiator) {
    const channel = new SecureChannel({ keys: this.keys, deviceId: this.deviceId, initiator, send: message => this.relaySocket?.send(Buffer.concat([Buffer.from([RELAY_PEER]), Buffer.from(peerId, 'hex'), message])) });
    this.relayChannels.set(peerId, channel);
    channel.on('open', id => { if (id !== peerId) channel.close('Unexpected device.'); else this.attach('relay', channel, initiator ? this.deviceId : peerId); });
    channel.on('close', () => { if (this.relayChannels.get(peerId) === channel) this.relayChannels.delete(peerId); });
    return channel;
  }
  ensureRelay(peerId) {
    if (!this.relayReady || !(this.deviceId < peerId) || this.relayChannels.has(peerId) || this.relayChannels.size >= MAX_PEERS) return;
    // At most one handshake per device each second, however often the relay asks.
    const wait = 1000 - (Date.now() - (this.relayStarted.get(peerId) || 0));
    if (wait > 0) {
      if (!this.relayRetry.has(peerId)) this.relayRetry.set(peerId, setTimeout(() => { this.relayRetry.delete(peerId); this.ensureRelay(peerId); }, wait).unref());
      return;
    }
    this.relayStarted.set(peerId, Date.now()); this.relayChannel(peerId, true).start();
  }

  // Public URLs served by the relay's own domain.
  expose({ id, name = '', host, port }) {
    if (!this.relayReady) return Promise.reject(new Error('Connect this device to your relay in Device mesh first.'));
    if (!this.relay.publicTunnels) return Promise.reject(new Error('Your relay has no public domain. Set DROPO_PUBLIC_DOMAIN on the relay to enable public URLs.'));
    return new Promise((resolve, reject) => {
      const tunnel = { id, name, host, port, url: null, online: false, error: '', resolve, reject };
      this.exposed.set(id, tunnel); this.requestTunnel(tunnel);
      setTimeout(() => { if (tunnel.reject) { tunnel.reject(new Error('The relay did not answer.')); tunnel.resolve = tunnel.reject = null; this.unexpose(id); } }, 15000).unref?.();
    });
  }
  requestTunnel(tunnel) { this.relaySocket?.send(JSON.stringify({ type: 'expose', id: tunnel.id, name: tunnel.name || undefined, hostHeader: hostPort(tunnel.host, tunnel.port) })); }
  unexpose(id) { if (this.exposed.delete(id)) this.relaySocket?.send(JSON.stringify({ type: 'unexpose', id })); }
}
