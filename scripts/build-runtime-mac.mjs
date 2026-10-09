import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { root, lock, download, run, sha256 } from './runtime-downloads.mjs';

if (process.platform !== 'darwin') throw new Error('Build the macOS runtime on macOS.');
const arch = process.argv[2] || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Supported architectures: arm64, x64.');
const targetArch = arch === 'x64' ? 'x86_64' : 'arm64';
const directory = path.join(root, 'vendor', `build-mac-${arch}`);
const prefix = path.join(directory, 'prefix');
const output = path.join(root, 'vendor', `darwin-${arch}`, 'openvpn');
const cacheKey = sha256(path.join(root, 'build/runtime-lock.json')) + ':' + sha256(new URL(import.meta.url));
const stamp = path.join(output, 'build-key');
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === cacheKey) { console.log('macOS runtime is current.'); process.exit(0); }
fs.rmSync(directory, { recursive: true, force: true });
fs.mkdirSync(prefix, { recursive: true });
const sources = {};
for (const name of ['openssl', 'lzo', 'lz4', 'openvpn']) {
  const archive = download(lock[name]);
  const source = path.join(directory, name);
  fs.mkdirSync(source);
  run('tar', ['-xzf', archive, '-C', source, '--strip-components=1']);
  sources[name] = source;
}
const jobs = String(Math.min(os.availableParallelism(), 8));
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.0', CC: 'clang', CFLAGS: `-O2 -arch ${targetArch}`, CPPFLAGS: `-I${prefix}/include`, LDFLAGS: `-arch ${targetArch} -L${prefix}/lib`, PKG_CONFIG_PATH: path.join(prefix, 'lib/pkgconfig') };
const build = (name, command, args, extra = {}) => run(command, args, { cwd: sources[name], env: { ...env, ...extra } });
build('openssl', 'perl', ['Configure', arch === 'arm64' ? 'darwin64-arm64-cc' : 'darwin64-x86_64-cc', 'no-shared', 'no-tests', 'no-module', 'no-dso', `--prefix=${prefix}`, '--libdir=lib']);
build('openssl', 'make', ['-j', jobs]);
build('openssl', 'make', ['install_sw']);
build('lzo', './configure', [`--prefix=${prefix}`, '--disable-shared', '--enable-static', `--host=${targetArch}-apple-darwin`]);
build('lzo', 'make', ['-j', jobs]);
build('lzo', 'make', ['install']);
build('lz4', 'make', ['-C', 'lib', '-j', jobs, 'BUILD_SHARED=no', 'BUILD_STATIC=yes', `PREFIX=${prefix}`, 'install']);
build('openvpn', './configure', [`--prefix=${prefix}`, '--disable-dco', '--disable-dns-updown-by-default', '--disable-plugins', '--disable-plugin-auth-pam', '--disable-plugin-down-root', '--disable-pkcs11', '--with-openssl-engine=no', '--disable-debug', '--disable-dependency-tracking', `--host=${targetArch}-apple-darwin`], { OPENSSL_CFLAGS: `-I${prefix}/include`, OPENSSL_LIBS: `-L${prefix}/lib -lssl -lcrypto`, LZO_CFLAGS: `-I${prefix}/include`, LZO_LIBS: `-L${prefix}/lib -llzo2`, LZ4_CFLAGS: `-I${prefix}/include`, LZ4_LIBS: `-L${prefix}/lib -llz4` });
build('openvpn', 'make', ['-j', jobs]);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'licenses'), { recursive: true });
const binary = path.join(output, 'openvpn');
fs.copyFileSync(path.join(sources.openvpn, 'src/openvpn/openvpn'), binary);
fs.chmodSync(binary, 0o755);
run('strip', ['-S', binary]);
run('codesign', ['--force', '--sign', '-', binary]);
const dependencies = execFileSync('otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1).map(x => x.trim().split(' ')[0]).filter(Boolean);
if (dependencies.some(x => !x.startsWith('/usr/lib/') && !x.startsWith('/System/Library/'))) throw new Error(`Runtime has non-system dependencies: ${dependencies.join(', ')}`);
for (const [name, source] of Object.entries(sources)) {
  const names = name === 'lz4' ? ['lib/LICENSE', 'LICENSE'] : ['COPYING', 'COPYRIGHT', 'LICENSE', 'LICENSE.txt', 'AUTHORS'];
  for (const file of names) if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(output, 'licenses', `${name}-${path.basename(file)}`));
}
fs.copyFileSync(path.join(root, 'build/openvpn-bundled-licenses.txt'), path.join(output, 'licenses/openvpn-bundled-licenses.txt'));
fs.copyFileSync(path.join(root, 'build/runtime-lock.json'), path.join(output, 'sources.json'));
fs.writeFileSync(path.join(output, 'README.txt'), 'OpenVPN runtime built for DropoVPN. No Homebrew installation is required.\nCorresponding source archives and build scripts accompany each DropoVPN release:\nhttps://github.com/samnimoh/dropovpn/releases\nOpenVPN is a separate GPL-licensed executable. See licenses/ and sources.json.\n');
fs.writeFileSync(stamp, cacheKey);
if (arch === process.arch) run(binary, ['--version']);
console.log(`Built self-contained OpenVPN ${lock.openvpn.version} for macOS ${arch}.`);
