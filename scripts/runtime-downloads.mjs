import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const lock = JSON.parse(fs.readFileSync(path.join(root, 'build/runtime-lock.json'), 'utf8'));
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.status}`);
}
export function download(item) {
  const directory = path.join(root, 'vendor/cache');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, item.file);
  if (!fs.existsSync(target)) {
    run('curl', ['--fail', '--location', '--retry', '3', '--silent', '--show-error', item.url, '--output', target + '.partial']);
    if (sha256(target + '.partial') !== item.sha256) throw new Error(`Checksum mismatch: ${item.file}`);
    fs.renameSync(target + '.partial', target);
  }
  if (sha256(target) !== item.sha256) throw new Error(`Checksum mismatch: ${item.file}`);
  return target;
}
