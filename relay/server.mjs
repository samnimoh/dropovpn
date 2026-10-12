import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from '../electron/websocket.mjs';
import { Mux, splice } from '../electron/mux.mjs';

// The DropoVPN relay connects mesh devices that cannot reach each other
// directly and serves public URLs on a domain you control. Mesh traffic is
// end-to-end encrypted between devices; the relay only forwards it. Public URL
// traffic is ordinary HTTP that the relay terminates and passes to a device.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PEER = 1, TUNNEL = 2;
const digest = value => createHash('sha256').update(String(value)).digest();
const randomName = () => Array.from(randomBytes(10), byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
const reply = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
// Absolute-form request targets can be invalid URLs; never let one throw.
const pathOf = target => { try { return new URL(target, 'http://relay'); } catch { return null; } };
const RESERVED = 10 * 60 * 1000;
const forwardedFor = request => [request.headers['x-forwarded-for'], request.socket.remoteAddress].filter(Boolean).join(', ');

export function createRelay({ token, publicDomain = '', publicScheme = 'https', publicPort = '', tls = null, maxDevices = 64, maxTunnels = 16, maxAgents = 2000, maxPerAddress = 32, deviceRate = 0, clientAddressHeader = '', log = () => {} }) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('Set DROPO_RELAY_TOKEN to a random value of at least 16 characters.');
  const domain = String(publicDomain).toLowerCase().replace(/^\.+|\.+$/g, '');
  const suffix = publicPort && String(publicPort) !== (publicScheme === 'https' ? '443' : '80') ? `:${publicPort}` : '';
  // Released public names stay reserved for their mesh for a while, so another
  // relay user cannot take over a URL while its device reconnects.
  const meshes = new Map(), tunnels = new Map(), reserved = new Map(), addresses = new Map(), expected = digest(token);
  let agents = 0;
  const server = tls ? https.createServer(tls, request) : http.createServer(request);
  server.headersTimeout = 30000; server.requestTimeout = 0; server.keepAliveTimeout = 30000;
  server.on('upgrade', upgrade);
  server.relay = { meshes, tunnels };
  return server;

  // Behind a proxy that sets it (Fly sets Fly-Client-IP), the header names the real client.
  function clientOf(incoming) { return (clientAddressHeader && String(incoming.headers[clientAddressHeader] || '').split(',')[0].trim()) || incoming.socket.remoteAddress || ''; }
  function hostOf(incoming) { return String(incoming.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, ''); }
  function authorized(incoming) {
    const match = String(incoming.headers.authorization || '').match(/^Bearer (\S+)$/);
    return !!match && timingSafeEqual(digest(match[1]), expected);
  }
  function request(incoming, response) {
    const host = hostOf(incoming), tunnel = tunnels.get(host);
    if (tunnel) return proxy(tunnel, incoming, response);
    const url = pathOf(incoming.url);
    if (!url) { response.writeHead(400).end(); return; }
    if (url.pathname === '/_dropovpn/v1/tls-allowed') {
      // For Caddy on-demand TLS: only issue certificates for active public URLs.
      response.writeHead(tunnels.has(String(url.searchParams.get('domain') || '').toLowerCase()) ? 200 : 404).end(); return;
    }
    const home = url.pathname === '/' && !(domain && host.endsWith('.' + domain));
    response.writeHead(home ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(home ? 'DropoVPN relay is running.\n' : domain && host.endsWith('.' + domain) ? 'This public URL is not active right now.\n' : 'Not found.\n');
  }
  function unavailable(response) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('The device sharing this URL is not reachable right now.\n');
  }
  function proxy(tunnel, incoming, response) {
    const headers = {};
    for (const [key, value] of Object.entries(incoming.headers)) if (!HOP.has(key)) headers[key] = value;
    Object.assign(headers, { host: tunnel.hostHeader, 'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': publicScheme, 'x-forwarded-for': forwardedFor(incoming) });
    // Node frames a streamed body itself only when told the request is chunked.
    if (incoming.headers['transfer-encoding']) headers['transfer-encoding'] = 'chunked';
    let upstream;
    try { upstream = http.request({ method: incoming.method, path: incoming.url, headers, createConnection: () => tunnel.agent.mux.open({ tunnel: tunnel.id }) }); }
    catch { unavailable(response); return; }
    upstream.on('response', answer => {
      const out = {};
      for (const [key, value] of Object.entries(answer.headers)) if (!HOP.has(key)) out[key] = value;
      response.writeHead(answer.statusCode, answer.statusMessage, out); answer.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) unavailable(response); else response.destroy(); });
    response.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  }
  function upgrade(incoming, socket, head) {
    socket.on('error', () => {});
    const url = pathOf(incoming.url);
    if (!url) return reply(socket, '400 Bad Request');
    // Device connections are matched before public URLs, so a device's access
    // token can never be routed to a tunnel, whatever the domain layout.
    const agentPath = url.pathname.endsWith('/_dropovpn/v1/agent') && 'x-dropovpn-mesh' in incoming.headers;
    const tunnel = !agentPath && tunnels.get(hostOf(incoming));
    if (tunnel) return tunnelUpgrade(tunnel, incoming, socket, head);
    if (!agentPath) return reply(socket, '404 Not Found');
    const mesh = String(incoming.headers['x-dropovpn-mesh'] || ''), device = String(incoming.headers['x-dropovpn-device'] || '');
    if (!authorized(incoming) || !/^[a-f0-9]{32}$/.test(mesh) || !/^[a-f0-9]{32}$/.test(device)) return reply(socket, '401 Unauthorized');
    const address = clientOf(incoming);
    if ((!meshes.get(mesh)?.has(device) && (meshes.get(mesh)?.size || 0) >= maxDevices) || agents >= maxAgents || (addresses.get(address) || 0) >= maxPerAddress) return reply(socket, '429 Too Many Requests');
    const ws = acceptWebSocket(incoming, socket, head, { maxMessage: 512 * 1024 });
    if (ws) join(mesh, device, ws, address);
  }
  function tunnelUpgrade(tunnel, incoming, socket, head) {
    let stream;
    try { stream = tunnel.agent.mux.open({ tunnel: tunnel.id }); } catch { return reply(socket, '502 Bad Gateway'); }
    const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const key = incoming.rawHeaders[index];
      if (!/^(host|x-forwarded-(host|proto|for))$/i.test(key)) lines.push(`${key}: ${incoming.rawHeaders[index + 1]}`);
    }
    lines.push(`Host: ${tunnel.hostHeader}`, `X-Forwarded-Host: ${incoming.headers.host}`, `X-Forwarded-Proto: ${publicScheme}`, `X-Forwarded-For: ${forwardedFor(incoming)}`);
    stream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) stream.write(head);
    splice(socket, stream);
  }
  function join(mesh, device, ws, address) {
    const members = meshes.get(mesh) || new Map(); meshes.set(mesh, members);
    const previous = members.get(device), agent = { mesh, device, ws, address, tunnels: new Map(), window: 0, used: 0 };
    agents++; addresses.set(address, (addresses.get(address) || 0) + 1);
    agent.mux = new Mux({ send: frame => ws.send(Buffer.concat([Buffer.from([TUNNEL]), frame])), initiator: true });
    agent.mux.on('stream', stream => stream.destroy(new Error('Devices cannot open relay streams.')));
    agent.mux.on('close', () => ws.close());
    members.set(device, agent);
    if (previous) { previous.ws.close(4409, 'Replaced by a newer connection.'); leave(previous, false); }
    ws.send(JSON.stringify({ type: 'welcome', peers: [...members.keys()].filter(id => id !== device), publicTunnels: !!domain }));
    for (const other of members.values()) if (other !== agent) other.ws.send(JSON.stringify({ type: 'joined', peer: device }));
    ws.on('message', (data, binary) => { try { if (binary) route(agent, data); else control(agent, data); } catch { ws.close(1002, 'Malformed message.'); } });
    ws.on('close', () => leave(agent, true));
    log(`Device ${device.slice(0, 8)} joined mesh ${mesh.slice(0, 8)} (${members.size} connected).`);
  }
  function leave(agent, announce) {
    if (agent.left) return;
    agent.left = true; agents--;
    const remaining = (addresses.get(agent.address) || 1) - 1;
    if (remaining) addresses.set(agent.address, remaining); else addresses.delete(agent.address);
    const members = meshes.get(agent.mesh), current = members?.get(agent.device) === agent;
    if (current) { members.delete(agent.device); if (!members.size) meshes.delete(agent.mesh); }
    for (const host of agent.tunnels.values()) if (tunnels.get(host)?.agent === agent) { tunnels.delete(host); reserved.set(host, { mesh: agent.mesh, until: Date.now() + RESERVED }); log(`Public URL ${host} is offline.`); }
    agent.tunnels.clear(); agent.mux.close();
    if (announce && current) for (const other of members.values()) other.ws.send(JSON.stringify({ type: 'left', peer: agent.device }));
  }
  // A device that sends faster than its budget is paused, not dropped, so its
  // end-to-end encrypted sessions stay intact while the relay's bandwidth stays bounded.
  function meter(agent, size) {
    if (!deviceRate) return;
    const second = Math.floor(Date.now() / 1000);
    if (agent.window !== second) { agent.window = second; agent.used = 0; }
    agent.used += size;
    if (agent.used > deviceRate && !agent.paused) {
      agent.paused = true; agent.ws.socket.pause();
      setTimeout(() => { agent.paused = false; agent.ws.socket.resume(); }, 1000 - (Date.now() % 1000)).unref?.();
    }
  }
  function route(agent, data) {
    meter(agent, data.length);
    if (data[0] === TUNNEL) { agent.mux.receive(data.subarray(1)); return; }
    if (data[0] !== PEER || data.length < 18) return;
    const target = meshes.get(agent.mesh)?.get(data.subarray(1, 17).toString('hex'));
    if (!target || target === agent) return;
    // Mesh flow control bounds normal traffic; a peer that still falls this far
    // behind is disconnected rather than buffered without limit.
    if (target.ws.bufferedAmount > 8 * 1024 * 1024) { target.ws.close(1013, 'Too far behind.'); return; }
    Buffer.from(agent.device, 'hex').copy(data, 1);
    target.ws.send(data);
  }
  function control(agent, text) {
    if (text.length > 4096) return;
    let message; try { message = JSON.parse(text); } catch { return; }
    const id = typeof message?.id === 'string' && /^[a-z0-9-]{1,64}$/.test(message.id) ? message.id : null;
    if (!id) return;
    if (message.type === 'unexpose') {
      const host = agent.tunnels.get(id);
      if (host && tunnels.get(host)?.agent === agent) { tunnels.delete(host); log(`Public URL ${host} stopped.`); }
      agent.tunnels.delete(id); return;
    }
    if (message.type !== 'expose') return;
    const refuse = error => agent.ws.send(JSON.stringify({ type: 'tunnel-error', id, error }));
    if (!domain) return refuse('This relay has no public domain.');
    const hostHeader = typeof message.hostHeader === 'string' && /^[a-z0-9.:[\]-]{1,300}$/i.test(message.hostHeader) ? message.hostHeader : null;
    if (!hostHeader) return refuse('Invalid local address.');
    let name = message.name == null ? '' : String(message.name).toLowerCase();
    if (name && !NAME.test(name)) return refuse('Names use 1 to 40 lowercase letters, numbers and dashes.');
    const previous = agent.tunnels.get(id);
    if (!previous && agent.tunnels.size >= maxTunnels) return refuse('This device already has too many public URLs.');
    for (const [host, hold] of reserved) if (hold.until < Date.now()) reserved.delete(host);
    if (!name) do name = randomName(); while (tunnels.has(`${name}.${domain}`) || reserved.has(`${name}.${domain}`));
    const host = `${name}.${domain}`;
    if ((tunnels.has(host) && tunnels.get(host).agent !== agent) || (reserved.has(host) && reserved.get(host).mesh !== agent.mesh)) return refuse('That name is already in use.');
    reserved.delete(host);
    if (previous && previous !== host) tunnels.delete(previous);
    tunnels.set(host, { agent, id, hostHeader }); agent.tunnels.set(id, host);
    agent.ws.send(JSON.stringify({ type: 'tunnel', id, name, url: `${publicScheme}://${host}${suffix}` }));
    log(`Public URL ${host} started.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  try {
    const tls = env.DROPO_TLS_CERT && env.DROPO_TLS_KEY ? { cert: fs.readFileSync(env.DROPO_TLS_CERT), key: fs.readFileSync(env.DROPO_TLS_KEY) } : null;
    const number = (name, fallback) => env[name] ? Number(env[name]) : fallback;
    const server = createRelay({ token: env.DROPO_RELAY_TOKEN, publicDomain: env.DROPO_PUBLIC_DOMAIN || '', publicScheme: env.DROPO_PUBLIC_SCHEME || 'https', publicPort: env.DROPO_PUBLIC_PORT || '', tls, maxAgents: number('DROPO_MAX_DEVICES', 2000), maxPerAddress: number('DROPO_MAX_PER_ADDRESS', 32), deviceRate: number('DROPO_DEVICE_RATE', 0), clientAddressHeader: (env.DROPO_CLIENT_ADDRESS_HEADER || '').toLowerCase(), log: message => console.log(new Date().toISOString(), message) });
    const port = Number(env.PORT || 8080), host = env.HOST || '0.0.0.0';
    server.listen(port, host, () => console.log(`DropoVPN relay listening on ${host}:${port}.${env.DROPO_PUBLIC_DOMAIN ? ` Public URLs: *.${env.DROPO_PUBLIC_DOMAIN}` : ' Public URLs are off; set DROPO_PUBLIC_DOMAIN to enable them.'}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
  } catch (error) { console.error(error.message); process.exit(1); }
}
