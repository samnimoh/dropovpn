import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

// A small RFC 6455 implementation shared by the desktop agent and the relay.
// It supports what DropoVPN needs: binary/text messages, fragmentation,
// ping/pong keepalive and close frames. Extensions are never negotiated.
const accept = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { client = false, head, maxMessage = 1024 * 1024, maxBuffered = 16 * 1024 * 1024, keepalive = 20000 } = {}) {
    super(); this.socket = socket; this.client = client; this.maxMessage = maxMessage; this.maxBuffered = maxBuffered;
    this.parts = []; this.size = 0; this.need = 2; this.fragments = []; this.fragmentType = 0; this.fragmentSize = 0; this.closed = false; this.closeSent = false; this.alive = true;
    socket.setNoDelay?.(true); socket.setTimeout?.(0);
    socket.on('data', chunk => this.receive(chunk));
    // A peer that half-closes without a close frame is gone.
    socket.on('end', () => socket.destroy());
    socket.on('close', () => this.finish(1006, ''));
    socket.on('error', () => {});
    socket.on('drain', () => this.emit('drain'));
    this.timer = setInterval(() => {
      if (!this.alive) { socket.destroy(); return; }
      this.alive = false; this.frame(0x9, Buffer.alloc(0));
    }, keepalive); this.timer.unref?.();
    // Frames that arrived with the handshake are parsed once the caller has
    // attached listeners. Later socket data is appended after them, in order.
    if (head?.length) { this.parts = [Buffer.from(head)]; this.size = head.length; setImmediate(() => this.receive(Buffer.alloc(0))); }
  }
  get bufferedAmount() { return this.socket.writableLength; }
  receive(chunk) {
    this.alive = true;
    if (chunk.length) { this.parts.push(chunk); this.size += chunk.length; }
    // Join buffered chunks only once a whole header or frame is available, so
    // a sender trickling bytes cannot make every chunk copy the backlog.
    if (this.size < this.need) return;
    let buffer = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.need = 2;
    while (!this.closed && buffer.length >= 2) {
      const first = buffer[0], second = buffer[1], masked = (second & 0x80) !== 0;
      if (first & 0x70 || masked === this.client) return this.fail(1002, 'Invalid frame.');
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) { this.need = 4; break; } length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) { this.need = 10; break; } if (buffer.readUInt32BE(2)) return this.fail(1009, 'Message too large.'); length = buffer.readUInt32BE(6); offset = 10; }
      if (length > this.maxMessage) return this.fail(1009, 'Message too large.');
      const start = offset + (masked ? 4 : 0), end = start + length;
      if (buffer.length < end) { this.need = end; break; }
      const payload = Buffer.from(buffer.subarray(start, end));
      if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= buffer[offset + (index & 3)];
      buffer = buffer.subarray(end);
      this.handle((first & 0x80) !== 0, first & 0x0f, payload);
    }
    this.parts = buffer.length && !this.closed ? [buffer] : []; this.size = this.parts.length ? buffer.length : 0;
  }
  handle(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this.fail(1002, 'Invalid control frame.');
      if (opcode === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this.close(code === 1005 ? 1000 : code); this.finish(code, payload.subarray(2).toString()); }
      else if (opcode === 0x9) this.frame(0xA, payload);
      else if (opcode !== 0xA) this.fail(1002, 'Unknown control frame.');
      return;
    }
    if (opcode === 0x0 ? !this.fragmentType : this.fragmentType || ![0x1, 0x2].includes(opcode)) return this.fail(1002, 'Unexpected frame.');
    if (opcode) this.fragmentType = opcode;
    this.fragments.push(payload); this.fragmentSize += payload.length;
    if (this.fragmentSize > this.maxMessage || this.fragments.length > 1024) return this.fail(1009, 'Message too large.');
    if (!fin) return;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments), binary = this.fragmentType === 0x2;
    this.fragments = []; this.fragmentType = 0; this.fragmentSize = 0;
    this.emit('message', binary ? message : message.toString('utf8'), binary);
  }
  frame(opcode, payload) {
    if (this.closeSent || this.socket.destroyed) return false;
    // A peer that stops reading (even while sending pings) is disconnected
    // rather than buffered without limit.
    if (this.socket.writableLength > this.maxBuffered) { this.socket.destroy(); return false; }
    const size = payload.length, extra = size < 126 ? 0 : size < 65536 ? 2 : 8, mask = this.client ? 4 : 0;
    const header = Buffer.alloc(2 + extra + mask);
    header[0] = 0x80 | opcode; header[1] = (mask ? 0x80 : 0) | (extra === 0 ? size : extra === 2 ? 126 : 127);
    if (extra === 2) header.writeUInt16BE(size, 2); else if (extra === 8) header.writeBigUInt64BE(BigInt(size), 2);
    if (mask) {
      const key = randomBytes(4); key.copy(header, 2 + extra);
      const masked = Buffer.from(payload); for (let index = 0; index < masked.length; index++) masked[index] ^= key[index & 3];
      payload = masked;
    }
    return this.socket.write(size ? Buffer.concat([header, payload]) : header);
  }
  send(data) { return this.frame(typeof data === 'string' ? 0x1 : 0x2, typeof data === 'string' ? Buffer.from(data) : data); }
  close(code = 1000, reason = '') {
    if (this.closeSent || this.socket.destroyed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason)); payload.writeUInt16BE(code); payload.write(reason, 2);
    this.frame(0x8, payload.subarray(0, 125)); this.closeSent = true;
    this.socket.end(); setTimeout(() => this.socket.destroy(), 2000).unref?.();
  }
  fail(code, reason) { this.close(code, reason); this.finish(code, reason); this.socket.destroy(); }
  finish(code, reason) {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.emit('close', code, reason);
  }
}

export function acceptWebSocket(request, socket, head, options) {
  const key = request.headers['sec-websocket-key'];
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\n\r\n`);
  return new WebSocketConnection(socket, { ...options, head });
}

export function connectWebSocket(address, { headers = {}, timeout = 15000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (!['ws:', 'wss:'].includes(url.protocol)) { reject(new Error('Use a ws:// or wss:// address.')); return; }
    const key = randomBytes(16).toString('base64');
    const request = (url.protocol === 'wss:' ? https : http).request({
      host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'wss:' ? 443 : 80), path: url.pathname + url.search, timeout,
      headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== accept(key)) { socket.destroy(); reject(new Error('The server did not accept the connection.')); return; }
      resolve(new WebSocketConnection(socket, { ...options, client: true, head }));
    });
    request.on('response', response => { response.resume(); reject(Object.assign(new Error(`The server answered with HTTP ${response.statusCode}.`), { status: response.statusCode })); });
    request.on('timeout', () => request.destroy(new Error('The server did not respond in time.')));
    request.on('error', reject);
    request.end();
  });
}
