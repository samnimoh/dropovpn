export function quoteManagement(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 4096) throw new Error('Credentials contain unsupported characters or are too long.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export function parseLine(line) {
  if (line.startsWith('>STATE:')) {
    const [time, state, detail, localIp, remoteIp] = line.slice(7).split(',');
    return { type: 'state', time, state, detail, localIp, remoteIp };
  }
  if (line.startsWith('>BYTECOUNT:')) {
    const [received, sent] = line.slice(11).split(',').map(Number);
    if (Number.isFinite(received) && Number.isFinite(sent)) return { type: 'traffic', received, sent };
  }
  if (line.startsWith('>PASSWORD:')) {
    const realm = line.match(/'([^']+)'/)?.[1];
    if (line.includes('Verification Failed')) return { type: 'auth-failed', realm };
    if (line.includes('SC:') || line.includes('CRV1:')) return { type: 'unsupported-auth' };
    if (line.includes('Need')) return { type: 'password', realm };
  }
  if (line.startsWith('>FATAL:')) return { type: 'fatal', message: line.slice(7) };
  if (line.startsWith('>HOLD:')) return { type: 'hold' };
  if (line.startsWith('>LOG:')) return { type: 'log', message: line.split(',').slice(2).join(',') };
  if (line.startsWith('>NEED-OK:') || line.startsWith('>NEED-STR:') || line.startsWith('>WEB_AUTH:')) return { type: 'unsupported-auth' };
  return null;
}

export function safeLog(message, secrets = []) {
  if (/MANAGEMENT: CMD|PASSWORD:|auth-token|AUTH_FAILED|CRV1|username|password|private key|BEGIN .*KEY|token=|dropovpn-peer:/i.test(message)) return null;
  let clean = message.replace(/[\x00-\x1f]/g, ' ');
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, '[redacted]');
  return clean.slice(0, 500);
}
