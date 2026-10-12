import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

// Many TCP connections share one mesh session or relay connection. Every
// frame is [type][stream id][payload]. Credit-based flow control bounds how
// much unread data a stream can buffer, so a slow browser or a stalled peer
// cannot make either side hold an unbounded amount of memory.
export const FRAME = { OPEN: 1, DATA: 2, WINDOW: 3, END: 4, RESET: 5, MESSAGE: 6, PING: 7, PONG: 8 };
const WINDOW = 256 * 1024, CHUNK = 16 * 1024, CREDIT = 32 * 1024, MAX_META = 4096;
const frame = (type, id, payload) => {
  const header = Buffer.allocUnsafe(5); header[0] = type; header.writeUInt32BE(id, 1);
  return payload?.length ? Buffer.concat([header, payload]) : header;
};
const uint32 = value => { const buffer = Buffer.allocUnsafe(4); buffer.writeUInt32BE(value); return buffer; };

class MuxStream extends Duplex {
  constructor(mux, id, meta) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024 });
    this.mux = mux; this.id = id; this.meta = meta; this.window = WINDOW; this.pending = null;
    this.received = 0; this.credited = 0; this.localEnded = false; this.remoteEnded = false; this.remoteReset = false;
    // Callers attach their own handlers; this keeps a reset from crashing the process.
    this.on('error', () => {});
  }
  _write(chunk, _encoding, callback) { this.pending = { chunk, callback }; this.pump(); }
  pump() {
    while (this.pending && this.window > 0 && !this.destroyed) {
      const { chunk, callback } = this.pending, size = Math.min(chunk.length, CHUNK, this.window);
      this.window -= size; this.mux.send(frame(FRAME.DATA, this.id, chunk.subarray(0, size)));
      if (size === chunk.length) { this.pending = null; callback(); } else this.pending.chunk = chunk.subarray(size);
    }
  }
  _final(callback) { this.localEnded = true; this.mux.send(frame(FRAME.END, this.id)); this.settle(); callback(); }
  _read() {
    // Return credit for bytes the consumer has actually taken from our buffer.
    const consumed = this.received - this.readableLength, amount = consumed - this.credited;
    if (amount >= CREDIT) { this.credited += amount; this.mux.send(frame(FRAME.WINDOW, this.id, uint32(amount))); }
  }
  data(payload) {
    if (this.remoteEnded) return this.destroy(new Error('Data arrived after the stream ended.'));
    this.received += payload.length;
    if (this.received - this.credited > WINDOW) return this.destroy(new Error('The peer ignored flow control.'));
    this.push(payload);
  }
  credit(amount) { this.window += amount; this.pump(); }
  remoteEnd() { if (this.remoteEnded) return; this.remoteEnded = true; this.push(null); this.settle(); }
  settle() { if (this.localEnded && this.remoteEnded) this.mux.streams.delete(this.id); }
  _destroy(error, callback) {
    if (!this.remoteReset && !(this.localEnded && this.remoteEnded)) this.mux.send(frame(FRAME.RESET, this.id, Buffer.from(String(error?.message || 'Closed').slice(0, 200))));
    this.mux.streams.delete(this.id);
    if (this.pending) { const { callback: done } = this.pending; this.pending = null; done(error || new Error('Stream closed.')); }
    callback(error);
  }
}

export class Mux extends EventEmitter {
  constructor({ send, initiator, maxStreams = 1024, keepalive = 15000 }) {
    super(); this.output = send; this.next = initiator ? 1 : 2; this.streams = new Map(); this.maxStreams = maxStreams; this.closed = false; this.lastSeen = Date.now();
    if (keepalive) {
      this.timer = setInterval(() => {
        if (Date.now() - this.lastSeen > keepalive * 3) this.close(new Error('The peer stopped responding.'));
        else this.send(frame(FRAME.PING, 0));
      }, keepalive);
      this.timer.unref?.();
    }
  }
  send(buffer) { if (!this.closed) this.output(buffer); }
  open(meta) {
    if (this.closed) throw new Error('The connection is closed.');
    const id = this.next; this.next += 2;
    const stream = new MuxStream(this, id, meta); this.streams.set(id, stream);
    this.send(frame(FRAME.OPEN, id, Buffer.from(JSON.stringify(meta))));
    return stream;
  }
  message(value) { this.send(frame(FRAME.MESSAGE, 0, Buffer.from(JSON.stringify(value)))); }
  receive(buffer) {
    if (this.closed) return;
    if (buffer.length < 5) { this.close(new Error('Malformed frame.')); return; }
    this.lastSeen = Date.now();
    const type = buffer[0], id = buffer.readUInt32BE(1), payload = buffer.subarray(5), stream = this.streams.get(id);
    if (type === FRAME.OPEN) {
      // Stream ids are odd for the side that started the session, even for the other.
      if (stream || id === 0 || id % 2 === this.next % 2 || this.streams.size >= this.maxStreams || payload.length > MAX_META) { this.send(frame(FRAME.RESET, id, Buffer.from('Refused'))); return; }
      let meta; try { meta = JSON.parse(payload.toString()); } catch { meta = null; }
      if (!meta || typeof meta !== 'object') { this.send(frame(FRAME.RESET, id, Buffer.from('Refused'))); return; }
      const created = new MuxStream(this, id, meta); this.streams.set(id, created);
      if (!this.emit('stream', created, meta)) created.destroy(new Error('Streams are not accepted here.'));
    } else if (type === FRAME.DATA) stream?.data(payload);
    else if (type === FRAME.WINDOW && payload.length === 4) stream?.credit(payload.readUInt32BE(0));
    else if (type === FRAME.END) stream?.remoteEnd();
    else if (type === FRAME.RESET) { if (stream) { stream.remoteReset = true; stream.destroy(new Error(payload.toString() || 'The stream was reset.')); } }
    else if (type === FRAME.MESSAGE) { let value; try { value = JSON.parse(payload.toString()); } catch { return; } this.emit('message', value); }
    else if (type === FRAME.PING) this.send(frame(FRAME.PONG, 0));
  }
  close(error) {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const stream of this.streams.values()) { stream.remoteReset = true; stream.destroy(error || new Error('The connection closed.')); }
    this.streams.clear(); this.emit('close', error);
  }
}

// Connect two streams, tearing both down if either fails.
export function splice(a, b) {
  const stop = error => { a.destroy(error); b.destroy(error); };
  a.on('error', stop); b.on('error', stop);
  a.on('close', () => { if (!a.readableEnded || !a.writableFinished) b.destroy(); });
  b.on('close', () => { if (!b.readableEnded || !b.writableFinished) a.destroy(); });
  a.pipe(b); b.pipe(a);
}
