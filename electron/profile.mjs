import fs from 'node:fs';
import path from 'node:path';

// An explicit allowlist keeps imported profiles from running programs, loading
// plugins, writing arbitrary files, or replacing our management channel.
const allowed = new Set(`client tls-client dev dev-type proto remote port rport nobind
remote-random remote-random-hostname float resolv-retry connect-retry connect-retry-max
connect-timeout server-poll-timeout persist-key persist-tun auth auth-user-pass auth-nocache
cipher data-ciphers data-ciphers-fallback tls-version-min tls-version-max tls-cipher
tls-ciphersuites remote-cert-tls remote-cert-ku remote-cert-eku verify-x509-name
key-direction reneg-sec reneg-bytes reneg-pkts hand-window tran-window tls-timeout
route route-ipv6 route-gateway route-metric route-delay route-nopull redirect-gateway
redirect-private pull pull-filter dhcp-option ifconfig ifconfig-ipv6 topology
tun-mtu tun-mtu-extra link-mtu mssfix fragment sndbuf rcvbuf tcp-nodelay
explicit-exit-notify ping ping-restart ping-exit ping-timer-rem keepalive
verb mute mute-replay-warnings auth-retry allow-compression compress comp-lzo
block-outside-dns windows-driver register-dns disable-dco peer-fingerprint push-peer-info
tls-exit fast-io proto-force remote-cert-ku remote-cert-eku`.split(/\s+/));
const embedded = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12', 'extra-certs', 'crl-verify']);
const managed = new Set(['auth-nocache', 'auth-retry', 'connect-retry', 'connect-retry-max', 'resolv-retry', 'ping', 'ping-restart', 'ping-exit', 'keepalive', 'persist-key', 'persist-tun', 'verb', 'mute']);
const optionalPlatformOptions = new Set(['block-outside-dns', 'register-dns', 'windows-driver']);
const modernCiphers = 'AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305';

export function tokenize(line) {
  const tokens = []; let token = '', quote = '', active = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { if (++i === line.length) throw new Error('Invalid trailing escape in profile.'); token += line[i]; active = true; }
    else if (quote) { if (c === quote) quote = ''; else token += c; }
    else if (c === '"' || c === "'") { quote = c; active = true; }
    else if ((c === '#' || c === ';') && !active) break;
    else if (/\s/.test(c)) { if (active) { tokens.push(token); token = ''; active = false; } }
    else { token += c; active = true; }
  }
  if (quote) throw new Error('Unclosed quote in profile.');
  if (active) tokens.push(token);
  return tokens;
}
export const configQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

export function normalizeProfile(source, resolveAsset, platform = process.platform) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('Profiles must be smaller than 2 MB.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) throw new Error('Invalid characters in profile.');
  const output = [], remotes = []; let block = null, protocol = 'udp', requiresAuth = false, hasTrust = false, device = false;
  let legacyCipher = null, hasDataCiphers = false, hasCipherFallback = false;
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      if (line === `</${block}>`) { output.push(line); block = null; }
      else { if (line.includes('<') || line.includes('>')) throw new Error('Invalid inline certificate block.'); output.push(raw); }
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line === '<connection>' || line === '</connection>') throw new Error('Connection blocks are not supported yet. Export a profile with remote entries at the top level.');
    const opening = line.match(/^<([a-z0-9-]+)>$/);
    if (opening) {
      if (!embedded.has(opening[1])) throw new Error(`Unsupported inline block: ${opening[1]}.`);
      block = opening[1]; if (block === 'ca' || block === 'pkcs12') hasTrust = true;
      output.push(line); continue;
    }
    const [rawDirective, ...args] = tokenize(line);
    if (!rawDirective) continue;
    let directive = rawDirective.replace(/^--/, '');
    if (directive === 'ignore-unknown-option') {
      // Exported profiles commonly include this for Windows DNS options. We
      // handle platform differences ourselves, without relaxing the allowlist
      // or passing a blanket "ignore unknown options" flag to OpenVPN.
      if (!args.length || args.some(option => !optionalPlatformOptions.has(option))) throw new Error('Only optional Windows DNS/driver options may appear in ignore-unknown-option.');
      continue;
    }
    if (directive === 'setenv') {
      // Common export metadata is harmless but never forwarded as environment
      // variables to an elevated process. Arbitrary setenv remains forbidden.
      if (['FORWARD_COMPATIBLE', 'CLIENT_CERT', 'FRIENDLY_NAME', 'SERVER'].includes(args[0])) continue;
      if (args[0] === 'opt' && ['block-outside-dns', 'register-dns'].includes(args[1])) { args.shift(); directive = args.shift(); }
    }
    if (embedded.has(directive)) {
      if (!args.length || args[0] === '[inline]') throw new Error(`Use a <${directive}> block or an adjacent certificate file.`);
      if (!resolveAsset) throw new Error(`Include ${directive} inside the .ovpn file.`);
      const body = resolveAsset(args[0], directive);
      if (/[<>\x00]/.test(body)) throw new Error(`Invalid ${directive} file.`);
      output.push(`<${directive}>`, body, `</${directive}>`);
      if (directive === 'ca' || directive === 'pkcs12') hasTrust = true;
      if (directive === 'tls-auth' && args[1]) output.push(`key-direction ${configQuote(args[1])}`);
      continue;
    }
    if (!allowed.has(directive)) throw new Error(`The "${directive}" option is not supported by DropoVPN. Scripts, plugins, and external includes are not permitted.`);
    if (directive === 'windows-driver' || (platform !== 'win32' && ['block-outside-dns', 'register-dns'].includes(directive))) continue;
    if (directive === 'dev') { if (args.length !== 1 || args[0] !== 'tun') throw new Error('This version supports routed (dev tun) profiles only.'); device = true; }
    if (directive === 'dev-type' && args[0] !== 'tun') throw new Error('Only tun devices are supported.');
    if (directive === 'remote') { if (!args[0] || args.length > 3) throw new Error('Invalid remote server.'); remotes.push(args[0]); }
    if (directive === 'proto') protocol = args[0] || 'udp';
    if (directive === 'peer-fingerprint') hasTrust = true;
    if (directive === 'remote-cert-tls' && args[0] !== 'server') throw new Error('The remote certificate must identify a server.');
    if (directive === 'auth-user-pass') { requiresAuth = true; output.push('auth-user-pass'); continue; }
    if (directive === 'cipher' && args.length === 1) legacyCipher = args[0].toUpperCase();
    if (directive === 'data-ciphers') hasDataCiphers = true;
    if (directive === 'data-ciphers-fallback') hasCipherFallback = true;
    if (managed.has(directive)) continue;
    output.push([directive, ...args.map(configQuote)].join(' '));
  }
  if (block) throw new Error(`Unclosed <${block}> block.`);
  if (!remotes.length) throw new Error('No remote server was found in this profile.');
  if (!hasTrust) throw new Error('Include a CA certificate, PKCS#12 bundle, or peer fingerprint to verify the VPN server.');
  if (!device) output.push('dev tun');
  // OpenVPN >=2.6 no longer selects a TLS data-channel cipher from `cipher`.
  // Migrate an explicitly requested AES-CBC cipher only for legacy profiles
  // that have no modern negotiation list. Respect an explicit list/fallback.
  if (!hasDataCiphers && /^AES-(128|192|256)-CBC$/.test(legacyCipher || '')) {
    output.push(`data-ciphers ${configQuote(`${modernCiphers}:${legacyCipher}`)}`);
    if (!hasCipherFallback) output.push(`data-ciphers-fallback ${configQuote(legacyCipher)}`);
  }
  output.push('client', 'remote-cert-tls server');
  if (Buffer.byteLength(output.join('\n')) > 2 * 1024 * 1024) throw new Error('The combined profile exceeds 2 MB.');
  return { config: output.join('\n') + '\n', server: remotes[0], protocol: protocol.toUpperCase(), requiresAuth };
}

export function importProfile(filename) {
  const parent = fs.realpathSync(path.dirname(filename));
  if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error('Profiles must be smaller than 2 MB.');
  return normalizeProfile(fs.readFileSync(filename, 'utf8'), (relative, kind) => {
    if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) throw new Error('Certificate paths must be relative to the profile.');
    const full = fs.realpathSync(path.resolve(parent, relative));
    if (!full.startsWith(parent + path.sep)) throw new Error('Certificate files must be inside the profile folder.');
    if (fs.statSync(full).size > 1024 * 1024) throw new Error('A certificate file exceeds 1 MB.');
    const bytes = fs.readFileSync(full);
    return kind === 'pkcs12' ? bytes.toString('base64') : bytes.toString('utf8');
  });
}
