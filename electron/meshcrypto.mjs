import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Every device in a mesh holds the same 32-byte secret. Nothing derived from it
// is reversible: the relay sees only the mesh id, and LAN neighbours see only
// MACs they cannot verify. Sessions use ephemeral X25519 keys mixed with the
// mesh secret, so recorded traffic stays private even if the secret leaks later.
const label = name => Buffer.from('dropovpn mesh v1 ' + name);
const derive = (secret, name, length = 32) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label(name), length));
const hmac = (key, ...parts) => { const mac = createHmac('sha256', key); for (const part of parts) mac.update(part); return mac.digest(); };
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const INIT = 1, RESPONSE = 2, RECORD = 3, VERSION = 1, HELLO = 98;

export const isDeviceId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function meshKeys(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('Invalid mesh key.');
  return { id: derive(secret, 'id', 16).toString('hex'), auth: derive(secret, 'auth'), session: derive(secret, 'session'), discovery: derive(secret, 'discovery') };
}

export function validateRelayURL(value) {
  if (value === '' || value == null) return '';
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a relay address such as wss://relay.example.com.'); }
  if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash || url.href.length > 512) throw new Error('Enter a relay address such as wss://relay.example.com.');
  return url.href;
}
export function validateRelayToken(value) {
  if (value === '' || value == null) return '';
  if (typeof value !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(value)) throw new Error('The relay access token must be 16 to 256 characters without spaces.');
  return value;
}
export function createInvite({ secret, relayURL = '', relayToken = '' }) {
  return 'dropo1.' + Buffer.from(JSON.stringify({ k: secret.toString('base64url'), ...(relayURL ? { r: relayURL } : {}), ...(relayToken ? { t: relayToken } : {}) })).toString('base64url');
}
export function parseInvite(text) {
  const invalid = () => new Error('That invite is not valid. Copy it again from a device in your mesh.');
  if (typeof text !== 'string' || text.length > 4096) throw invalid();
  const match = text.trim().match(/^dropo1\.([A-Za-z0-9_-]+)$/);
  if (!match) throw invalid();
  let value; try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString()); } catch { throw invalid(); }
  const secret = typeof value?.k === 'string' ? Buffer.from(value.k, 'base64url') : null;
  if (!secret || secret.length !== 32) throw invalid();
  return { secret, relayURL: validateRelayURL(value.r), relayToken: validateRelayToken(value.t) };
}

// LAN announcement: magic | nonce | masked device id | TCP port | timestamp |
// truncated MAC. The id is masked with a fresh nonce each time, so people on a
// shared network cannot follow one device from packet to packet.
const MAGIC = Buffer.from('DROPOMESH2'), PACKET = 60;
const mask = (keys, nonce) => hmac(keys.discovery, Buffer.from('mask'), nonce).subarray(0, 16);
const xor = (a, b) => Buffer.from(a.map((byte, index) => byte ^ b[index]));
export function discoveryPacket(keys, deviceId, port, now = Date.now()) {
  const body = Buffer.alloc(PACKET - 16), nonce = randomBytes(8);
  MAGIC.copy(body); nonce.copy(body, 10); xor(Buffer.from(deviceId, 'hex'), mask(keys, nonce)).copy(body, 18); body.writeUInt16BE(port, 34); body.writeBigUInt64BE(BigInt(now), 36);
  return Buffer.concat([body, hmac(keys.discovery, body).subarray(0, 16)]);
}
export function readDiscovery(keys, packet, now = Date.now()) {
  if (packet.length !== PACKET || !packet.subarray(0, 10).equals(MAGIC)) return null;
  const body = packet.subarray(0, PACKET - 16);
  if (!same(hmac(keys.discovery, body).subarray(0, 16), packet.subarray(PACKET - 16))) return null;
  if (Math.abs(now - Number(body.readBigUInt64BE(36))) > 120000) return null;
  const port = body.readUInt16BE(34);
  return port ? { deviceId: xor(body.subarray(18, 34), mask(keys, body.subarray(10, 18))).toString('hex'), port } : null;
}

// A two-message handshake over any ordered message transport (a TCP socket or
// a relay channel), followed by AES-256-GCM records with counter nonces.
export class SecureChannel extends EventEmitter {
  constructor({ keys, deviceId, send, initiator, timeout = 10000 }) {
    super(); this.keys = keys; this.deviceId = deviceId; this.output = send; this.initiator = initiator;
    this.peerId = null; this.open = false; this.closed = false; this.sent = 0n; this.received = 0n;
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    this.privateKey = privateKey; this.publicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    this.timer = setTimeout(() => this.close('The secure handshake timed out.'), timeout); this.timer.unref?.();
  }
  start() {
    if (!this.initiator || this.hello) return;
    const head = Buffer.concat([Buffer.from([INIT, VERSION]), Buffer.from(this.deviceId, 'hex'), this.publicKey, randomBytes(16)]);
    this.hello = Buffer.concat([head, hmac(this.keys.auth, head)]);
    this.output(this.hello);
  }
  receive(message) {
    if (this.closed) return;
    try {
      if ((this.open || this.receiveKey) && message[0] === RECORD) {
        const plain = this.decrypt(message);
        // The responder waits for proof that the initiator derived the same
        // keys, so a replayed handshake message never becomes a session.
        if (!this.open) { this.open = true; clearTimeout(this.timer); this.emit('open', this.peerId); }
        return this.emit('record', plain);
      }
      if (!this.initiator && message[0] === INIT && !this.hello) return this.accept(message);
      if (!this.open && this.initiator && message[0] === RESPONSE && this.hello) return this.complete(message);
      this.close('Unexpected handshake message.');
    } catch (error) { this.close(error.message); }
  }
  accept(message) {
    const head = this.verify(message, Buffer.alloc(0));
    const reply = Buffer.concat([Buffer.from([RESPONSE, VERSION]), Buffer.from(this.deviceId, 'hex'), this.publicKey, randomBytes(16)]);
    this.hello = Buffer.from(message);
    const response = Buffer.concat([reply, hmac(this.keys.auth, this.hello, reply)]);
    // Derive keys first: if that fails, the initiator never sees a response.
    this.establish(head, this.hello, response); this.output(response);
  }
  complete(message) { this.establish(this.verify(message, this.hello), this.hello, Buffer.from(message)); }
  verify(message, prefix) {
    if (message.length !== HELLO || message[1] !== VERSION) throw new Error('Unsupported mesh protocol.');
    if (!same(hmac(this.keys.auth, prefix, message.subarray(0, 66)), message.subarray(66))) throw new Error('This device is not part of your mesh.');
    const peerId = message.subarray(2, 18).toString('hex');
    if (peerId === this.deviceId) throw new Error('Refusing to connect to this device.');
    return { peerId, publicKey: Buffer.from(message.subarray(18, 50)) };
  }
  establish({ peerId, publicKey }, init, response) {
    const shared = diffieHellman({ privateKey: this.privateKey, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, publicKey]), format: 'der', type: 'spki' }) });
    if (shared.every(byte => byte === 0)) throw new Error('Invalid peer key.');
    const transcript = createHash('sha256').update(init).update(response).digest();
    const okm = Buffer.from(hkdfSync('sha256', shared, this.keys.session, Buffer.concat([label('session'), transcript]), 64));
    [this.sendKey, this.receiveKey] = this.initiator ? [okm.subarray(0, 32), okm.subarray(32)] : [okm.subarray(32), okm.subarray(0, 32)];
    this.peerId = peerId; this.privateKey = null;
    if (this.initiator) { this.open = true; clearTimeout(this.timer); this.emit('open', peerId); }
  }
  nonce(counter) { const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(counter, 4); return nonce; }
  write(plain) {
    if (!this.open || this.closed) return;
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, this.nonce(this.sent++)); cipher.setAAD(Buffer.from([RECORD]));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    this.output(Buffer.concat([Buffer.from([RECORD]), body, cipher.getAuthTag()]));
  }
  decrypt(message) {
    if (message.length < 17) throw new Error('Malformed record.');
    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, this.nonce(this.received++));
    decipher.setAAD(Buffer.from([RECORD])); decipher.setAuthTag(message.subarray(message.length - 16));
    try { return Buffer.concat([decipher.update(message.subarray(1, message.length - 16)), decipher.final()]); }
    catch { throw new Error('A mesh record failed authentication.'); }
  }
  close(reason = 'Closed') {
    if (this.closed) return;
    this.closed = true; this.open = false; clearTimeout(this.timer); this.privateKey = null; this.sendKey = this.receiveKey = null;
    this.emit('close', reason);
  }
}
