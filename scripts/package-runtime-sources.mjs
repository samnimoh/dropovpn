import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, lock, download, run, sha256 } from './runtime-downloads.mjs';

// Sources are published beside the installers, not just linked to third parties.
// The Windows build commit pins the exact source submodules and vcpkg patches.
const additional = [
  ['openvpn-build-14f7383.tar.gz', 'https://github.com/OpenVPN/openvpn-build/archive/14f7383bdb2212f587df6121c6bba8a770815d6e.tar.gz'],
  ['openvpn-gui-ee41d6d.tar.gz', 'https://github.com/OpenVPN/openvpn-gui/archive/ee41d6d4738904bbf6a3d64271400e324c8e2e41.tar.gz'],
  ['vcpkg-4b308f5.tar.gz', 'https://github.com/microsoft/vcpkg/archive/4b308f5ccd45aed57f2977257bca304dfef43c99.tar.gz'],
  ['pkcs11-helper-1.31.0.tar.bz2', 'https://github.com/OpenSC/pkcs11-helper/releases/download/pkcs11-helper-1.31.0/pkcs11-helper-1.31.0.tar.bz2'],
  ['tap-windows6-9.27.0.tar.gz', 'https://github.com/OpenVPN/tap-windows6/archive/refs/tags/9.27.0.tar.gz'],
  ['ovpn-dco-win-2.8.13.tar.gz', 'https://github.com/OpenVPN/ovpn-dco-win/archive/refs/tags/2.8.13.tar.gz'],
  ['openvpnserv2-2.0.1.0.tar.gz', 'https://github.com/OpenVPN/openvpnserv2/archive/refs/tags/2.0.1.0.tar.gz'],
  ['easy-rsa-3.2.7.tar.gz', 'https://github.com/OpenVPN/easy-rsa/archive/refs/tags/v3.2.7.tar.gz'],
  ['json-c-0.19-20260627.tar.gz', 'https://github.com/json-c/json-c/archive/refs/tags/json-c-0.19-20260627.tar.gz'],
  ['UnxUtilsSrc.zip', 'https://downloads.sourceforge.net/project/unxutils/unxutils/current/UnxUtilsSrc.zip']
];
const cache = path.join(root, 'vendor/source-cache');
const output = path.join(root, 'vendor/corresponding-sources');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const execute = promisify(execFile);
for (let start = 0; start < additional.length; start += 3) {
  await Promise.all(additional.slice(start, start + 3).map(async ([file, url]) => {
    const target = path.join(cache, file);
    if (!fs.existsSync(target)) {
      console.log(`Fetching source: ${file}`);
      await execute('curl', ['--fail', '--location', '--retry', '3', '--silent', '--show-error', url, '--output', target + '.partial']);
      fs.renameSync(target + '.partial', target);
    }
    fs.copyFileSync(target, path.join(output, file));
  }));
}
for (const item of Object.values(lock)) fs.copyFileSync(download(item), path.join(output, item.file));
for (const file of ['scripts/build-runtime-mac.mjs', 'scripts/runtime-downloads.mjs', 'scripts/prepare-runtime-win.mjs', 'scripts/package-runtime-sources.mjs', 'build/runtime-lock.json', 'build/windows-runtime.json', 'build/openvpn-bundled-licenses.txt', 'build/openvpn-windows-license.txt', 'THIRD-PARTY-NOTICES.txt']) {
  fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
const archives = [...Object.values(lock).map(x => [x.file, x.url]), ...additional];
fs.writeFileSync(path.join(output, 'SOURCES.json'), JSON.stringify(archives.map(([file, url]) => ({ file, url, sha256: sha256(path.join(output, file)) })), null, 2) + '\n');
fs.writeFileSync(path.join(output, 'README.txt'), `Corresponding sources for DropoVPN 0.2.0 runtimes\n\nmacOS: OpenVPN ${lock.openvpn.version}, OpenSSL ${lock.openssl.version}, LZO ${lock.lzo.version}, LZ4 ${lock.lz4.version}. Build with Node.js 24+, Xcode command line tools, and pkg-config: node scripts/build-runtime-mac.mjs. The build script verifies source hashes and links non-system libraries statically. Sources are unmodified.\n\nWindows: unmodified official OpenVPN 2.7.8-I001 MSI. The included openvpn-build snapshot identifies the release and contains build/installer recipes. Its src/openvpn and src/openvpn-gui submodules correspond to the OpenVPN and GUI sources provided here; src/vcpkg corresponds to the included vcpkg snapshot (which includes library patches). Follow windows-msi/README.rst in that source to rebuild. The additional archives provide driver, service, library, Easy-RSA and UnxUtils sources, including components in the upstream MSI that DropoVPN does not select for installation. The optional Linux-only ovpn-backports submodule is not part of these macOS/Windows binaries.\n\nThe Microsoft Windows SDK/WDK and compiler are separate system build tools. Their code-signing keys are not part of the source; rebuilt drivers need appropriate signing to install on Windows.\n\nSee SOURCES.json for archive hashes and upstream locations, and each archive for its original license terms.\n`);
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
run('tar', ['-czf', path.join(root, 'release/DropoVPN-0.2.0-runtime-sources.tar.gz'), '-C', path.dirname(output), path.basename(output)]);
console.log('Packaged the runtime source archives and build instructions.');
