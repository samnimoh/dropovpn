import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { engineCandidates, detectEngine } from '../electron/launcher.mjs';

test('macOS searches the relocatable app runtime before Homebrew, while honoring an explicit override', () => {
  const options = { platform: 'darwin', resourcesPath: '/Applications/A folder/DropoVPN.app/Contents/Resources' };
  assert.equal(engineCandidates('', options)[0], '/Applications/A folder/DropoVPN.app/Contents/Resources/openvpn/openvpn');
  assert.deepEqual(engineCandidates('/custom/openvpn', options), ['/custom/openvpn']);
});

test('Windows uses the native Program Files directory even from a 32-bit parent environment', () => {
  assert.deepEqual(engineCandidates('', { platform: 'win32', env: { ProgramW6432: 'D:\\Program Files', ProgramFiles: 'D:\\Program Files (x86)' } }), ['D:\\Program Files\\OpenVPN\\bin\\openvpn.exe']);
});

test('detects a working bundled executable after relocating the application', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-runtime-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'openvpn'));
    fs.writeFileSync(path.join(directory, 'openvpn/openvpn'), '#!/bin/sh\nprintf "OpenVPN 2.7.8 test runtime\\n"\n', { mode: 0o755 });
    const engine = await detectEngine('', { platform: 'darwin', resourcesPath: directory });
    assert.equal(engine.bundled, true);
    assert.equal(engine.path, path.join(directory, 'openvpn/openvpn'));
    assert.equal(engine.version, '2.7.8');
    const missing = await detectEngine(path.join(directory, 'missing/openvpn'));
    assert.equal(missing.available, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
