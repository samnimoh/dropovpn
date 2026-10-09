import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, tokenize, importProfile } from '../electron/profile.mjs';
import { quoteManagement, parseLine, safeLog } from '../electron/protocol.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = 'client\ndev tun\nremote vpn.example.test 1194\nproto udp\nauth-user-pass\n<ca>\ncertificate\n</ca>\n';

test('imports a profile and preserves inline certificates', () => {
  const p = normalizeProfile(base + 'persist-key\nverb 9\nping-restart 600\n');
  assert.equal(p.server, 'vpn.example.test'); assert.equal(p.requiresAuth, true);
  assert.equal(p.protocol, 'UDP'); assert.match(p.config, /<ca>\ncertificate\n<\/ca>/);
  assert.doesNotMatch(p.config, /persist-key|verb 9|ping-restart/);
});
test('normalization remains valid when revalidating encrypted profiles', () => {
  assert.equal(normalizeProfile(normalizeProfile(base).config).server, 'vpn.example.test');
});
test('rejects privileged escape directives and external includes', () => {
  for (const directive of ['up /tmp/code', 'down /tmp/code', 'plugin /tmp/code', 'config /tmp/other', 'management 0.0.0.0 8888', 'log /tmp/file', 'writepid /tmp/file', 'script-security 3', 'setenv PATH /tmp', 'tls-verify /tmp/code', 'iproute /tmp/code', 'engine custom', 'tls-export-cert /tmp']) assert.throws(() => normalizeProfile(base + directive), /not supported/);
});
test('rejects tampered inline blocks, missing trust, TAP and malformed quoting', () => {
  assert.throws(() => normalizeProfile(base.replace('</ca>', '')), /Unclosed/);
  assert.throws(() => normalizeProfile(base.replace('certificate', '<bad>')), /Invalid inline/);
  assert.throws(() => normalizeProfile('client\nremote a.test\n'), /CA certificate/);
  assert.throws(() => normalizeProfile(base.replace('dev tun', 'dev tap')), /routed/);
  assert.throws(() => tokenize('remote "unfinished'), /Unclosed/);
});
test('inlines adjacent certs and prevents path and symlink escape', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'profiles'));
  fs.writeFileSync(path.join(directory, 'outside.pem'), 'outside');
  const profilePath = path.join(directory, 'profiles', 'client.ovpn');
  fs.writeFileSync(path.join(directory, 'profiles', 'CA file.pem'), 'certificate');
  fs.writeFileSync(profilePath, 'client\nremote vpn.test\nca "CA file.pem"\n');
  assert.match(importProfile(profilePath).config, /<ca>\ncertificate/);
  fs.writeFileSync(profilePath, 'client\nremote vpn.test\nca ../outside.pem\n');
  assert.throws(() => importProfile(profilePath), /inside the profile folder/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(directory, 'outside.pem'), path.join(directory, 'profiles', 'link.pem'));
    fs.writeFileSync(profilePath, 'client\nremote vpn.test\nca link.pem\n');
    assert.throws(() => importProfile(profilePath), /inside the profile folder/);
  }
});
test('ignores referenced auth files in favor of managed sign-in', () => {
  const p = normalizeProfile(base.replace('auth-user-pass', 'auth-user-pass "passwords.txt"'));
  assert.match(p.config, /auth-user-pass\n/); assert.doesNotMatch(p.config, /passwords.txt/);
});
test('accepts common exported metadata and handles Windows-only options on macOS', () => {
  const profile = base + 'setenv FORWARD_COMPATIBLE 1\nsetenv CLIENT_CERT 0\nsetenv opt block-outside-dns\n';
  assert.doesNotMatch(normalizeProfile(profile, undefined, 'darwin').config, /setenv|block-outside-dns/);
  assert.match(normalizeProfile(profile, undefined, 'win32').config, /block-outside-dns/);
  assert.throws(() => normalizeProfile(base + 'setenv DYLD_INSERT_LIBRARIES /tmp/evil'), /not supported/);
});
test('imports the KNUST-style option set on macOS and Windows without relaxing validation', () => {
  // Synthetic certificate placeholders: never commit a user's certificates,
  // private key or tls-crypt secret as a fixture.
  const source = base + 'auth-nocache\nsndbuf 0\nrcvbuf 0\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\nauth SHA512\ncipher AES-256-CBC\nignore-unknown-option block-outside-dns\nblock-outside-dns\nverb 3\nexplicit-exit-notify 1\n<cert>\nCERTIFICATE\n</cert>\n<key>\nPRIVATE MATERIAL\n</key>\n<tls-crypt>\nSTATIC MATERIAL\n</tls-crypt>\n';
  for (const platform of ['darwin', 'win32']) {
    const p = normalizeProfile(source, undefined, platform);
    assert.doesNotMatch(p.config, /ignore-unknown-option/);
    assert.match(p.config, /data-ciphers "AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC"/);
    assert.match(p.config, /data-ciphers-fallback "AES-256-CBC"/);
    assert.match(p.config, /<tls-crypt>\nSTATIC MATERIAL\n<\/tls-crypt>/);
    assert.equal(p.config.includes('block-outside-dns'), platform === 'win32');
    const repeated = normalizeProfile(p.config, undefined, platform).config;
    assert.equal(repeated.match(/^data-ciphers /gm).length, 1);
    assert.equal(repeated.match(/^data-ciphers-fallback /gm).length, 1);
  }
  assert.throws(() => normalizeProfile(base + 'ignore-unknown-option plugin\nplugin /tmp/code'), /Only optional/);
  assert.throws(() => normalizeProfile(base + 'ignore-unknown-option block-outside-dns\nup /tmp/code'), /not supported/);
});
test('does not broaden explicit data cipher policy or invent CBC for other profiles', () => {
  const modern = normalizeProfile(base + 'cipher AES-256-CBC\ndata-ciphers AES-256-GCM\n').config;
  assert.match(modern, /data-ciphers "AES-256-GCM"/);
  assert.doesNotMatch(modern, /data-ciphers-fallback|AES-128-GCM/);
  const fallback = normalizeProfile(base + 'cipher AES-256-CBC\ndata-ciphers-fallback AES-128-CBC\n').config;
  assert.equal(fallback.match(/^data-ciphers-fallback /gm).length, 1);
  assert.match(fallback, /data-ciphers-fallback "AES-128-CBC"/);
  assert.doesNotMatch(normalizeProfile(base).config, /data-ciphers/);
  assert.doesNotMatch(normalizeProfile(base + 'cipher BF-CBC\n').config, /data-ciphers/);
});
test('quotes credentials and prevents management command injection', () => {
  assert.equal(quoteManagement('a"b\\c'), '"a\\"b\\\\c"');
  for (const value of ['pass\nsignal SIGTERM', 'pass\r', '\0', 'x'.repeat(5000)]) assert.throws(() => quoteManagement(value));
});
test('parses state, traffic, authentication, and private-key rejection', () => {
  assert.equal(parseLine('>STATE:1,CONNECTED,SUCCESS,10.1.0.2,203.0.113.1').localIp, '10.1.0.2');
  assert.deepEqual(parseLine('>BYTECOUNT:12,30'), { type: 'traffic', received: 12, sent: 30 });
  assert.equal(parseLine(">PASSWORD:Need 'Auth' username/password").realm, 'Auth');
  assert.equal(parseLine(">PASSWORD:Verification Failed: 'Private Key'").realm, 'Private Key');
  assert.equal(parseLine(">PASSWORD:Need 'Auth' username/password SC:1,Code").type, 'unsupported-auth');
});
test('redacts credentials and suppresses authentication logs', () => {
  assert.equal(safeLog('peer says very-secret', ['very-secret']), 'peer says [redacted]');
  for (const line of ['MANAGEMENT: CMD password abc', 'auth-token 123', 'AUTH_FAILED secret', 'password abc']) assert.equal(safeLog(line), null);
});
