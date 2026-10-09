import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Store } from '../electron/store.mjs';

test('persists encrypted credentials and profile data, lists no secrets, and forgets them', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-store-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true, encryptString(value) { const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final()]); }, decryptString(value) { const cipher = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16)); return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString(); } };
  const store = new Store(directory, encryption);
  const id = store.add('Work', { config: 'PRIVATE CERTIFICATE', server: 'vpn.test', protocol: 'UDP', requiresAuth: true });
  store.saveCredentials(id, { username: 'sam', password: 'SECRET PASSWORD' });
  const disk = fs.readFileSync(store.file, 'utf8'); assert.doesNotMatch(disk, /PRIVATE CERTIFICATE|SECRET PASSWORD/);
  assert.equal(store.list()[0].hasCredentials, true); assert.equal(store.list()[0].encryptedConfig, undefined);
  const reloaded = new Store(directory, encryption);
  assert.equal(reloaded.credentials(id).password, 'SECRET PASSWORD'); assert.equal(reloaded.config(id), 'PRIVATE CERTIFICATE');
  reloaded.forget(id); assert.equal(reloaded.credentials(id), null); assert.equal(reloaded.list()[0].hasCredentials, false);
  reloaded.remove(id); assert.equal(reloaded.list().length, 0);
});
test('refuses plaintext fallback when OS encryption is unavailable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-vault-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory, { isEncryptionAvailable: () => false });
  assert.throws(() => store.add('Work', { config: 'private' }), /credential store is unavailable/);
  assert.equal(store.list().length, 0);
});
