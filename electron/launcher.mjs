import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => Buffer.from(value, 'utf16le').toString('base64');

export const managementArguments = port => ['--management', '127.0.0.1', String(port), 'management.pass', '--management-client', '--management-query-passwords', '--management-hold', '--auth-retry', 'interact', '--auth-nocache', '--resolv-retry', 'infinite', '--connect-retry', '2', '30', '--persist-tun', '--ping', '10', '--ping-restart', '30', '--verb', '3'];

export async function detectEngine(custom = '') {
  const candidates = custom ? [custom] : process.platform === 'darwin'
    ? ['/opt/homebrew/sbin/openvpn', '/opt/homebrew/bin/openvpn', '/usr/local/sbin/openvpn', '/usr/local/bin/openvpn']
    : [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenVPN', 'bin', 'openvpn.exe')];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !/^openvpn(?:\.exe)?$/i.test(path.basename(candidate))) continue;
      const { stdout } = await execute(candidate, ['--version'], { timeout: 5000, windowsHide: true });
      const version = stdout.match(/OpenVPN (2\.(\d+)\.\d+)/);
      if (version && Number(version[2]) >= 6) return { available: true, path: candidate, version: version[1] };
    } catch { /* Continue to the next standard installation. */ }
  }
  return { available: false, path: custom, version: null };
}

export function launchOpenVPN({ binary, config, port, token, platform = process.platform }) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('DropoVPN supports macOS and Windows.');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dropovpn-'));
  fs.chmodSync(stage, 0o700);
  const files = { 'profile.ovpn': config, 'management.pass': token + '\n' };
  if (platform === 'darwin') files['dns.sh'] = fs.readFileSync(fileURLToPath(new URL('./dns.sh', import.meta.url)), 'utf8');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(stage, name), content, { mode: 0o600 });
  const args = managementArguments(port);
  let child;
  if (platform === 'darwin') {
    // Snapshot verified bytes into a root-owned directory before OpenVPN reads
    // them. No mutable user config, script path, or VPN credential is executed.
    const copy = Object.entries(files).map(([name, content]) => {
      const source = shellQuote(path.join(stage, name));
      return `/bin/cp ${source} "$runtime/${name}"\n[ "$(/usr/bin/shasum -a 256 "$runtime/${name}" | /usr/bin/cut -d ' ' -f 1)" = '${hash(content)}' ] || exit 74`;
    }).join('\n');
    const script = `set -eu\numask 077\nruntime=$(/usr/bin/mktemp -d /private/var/run/dropovpn.XXXXXX)\ncleanup() { if [ -f "$runtime/dns-device" ]; then dev=$(/bin/cat "$runtime/dns-device") script_type=down "$runtime/dns.sh" >/dev/null 2>&1 || true; fi; /bin/rm -rf "$runtime"; }\ntrap cleanup EXIT\n${copy}\n/bin/chmod 700 "$runtime/dns.sh"\ncd "$runtime"\n${shellQuote(binary)} --config profile.ovpn ${args.map(shellQuote).join(' ')} --script-security 2 --up "$runtime/dns.sh" --down "$runtime/dns.sh" --down-pre --up-restart >/dev/null 2>&1`;
    const apple = `with timeout of 2147483647 seconds\ndo shell script ${JSON.stringify(script)} with administrator privileges with prompt "DropoVPN needs permission to create a VPN tunnel."\nend timeout`;
    child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(apple);
  } else {
    const copy = Object.entries(files).map(([name, content]) => `Copy-Item -LiteralPath ${psQuote(path.join(stage, name))} -Destination (Join-Path $runtime '${name}'); if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtime '${name}')).Hash -ne '${hash(content)}') { throw 'Profile changed during elevation' }`).join('\n');
    const inner = `$ErrorActionPreference='Stop'
$runtime=Join-Path $env:ProgramData ('DropoVPN-'+[guid]::NewGuid().ToString())
try {
  New-Item -ItemType Directory -Path $runtime | Out-Null
  $acl=Get-Acl -LiteralPath $runtime
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }
  Set-Acl -LiteralPath $runtime -AclObject $acl
  ${copy}
  Set-Location -LiteralPath $runtime
  & ${psQuote(binary)} '--config' 'profile.ovpn' ${args.map(psQuote).join(' ')} '--script-security' '1'
  $result=$LASTEXITCODE
} catch { $result=1 } finally { Set-Location $env:SystemRoot; if(Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force } }
exit $result`;
    const outer = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded(inner)}') -PassThru -Wait; exit $p.ExitCode } catch { exit 1223 }`;
    child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outer)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  child.cleanupStaging = cleanup;
  child.once('close', cleanup); child.once('error', cleanup);
  return child;
}
