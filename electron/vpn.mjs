import { EventEmitter } from 'node:events';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { launchOpenVPN } from './launcher.mjs';
import { normalizeProfile } from './profile.mjs';
import { parseLine, quoteManagement, safeLog } from './protocol.mjs';

const idle = () => ({ status: 'disconnected', profileId: null, connectedAt: null, localIp: null, remoteIp: null, received: 0, sent: 0, reconnects: 0, message: 'Ready when you are.', prompt: null });

export class VPN extends EventEmitter {
  constructor({ store, launch = launchOpenVPN, startupTimeout = 120000, retryDelay = 2000 }) {
    super(); this.store = store; this.launch = launch; this.startupTimeout = startupTimeout;
    this.state = idle(); this.logs = []; this.session = null; this.retryTimer = null; this.retryCount = 0; this.retryDelay = retryDelay;
  }
  update(patch) { Object.assign(this.state, patch); this.emit('change'); }
  log(message, level = 'info') {
    const clean = safeLog(message, [this.session?.credentials?.username, this.session?.credentials?.password, this.session?.privateKey]);
    if (!clean) return;
    this.logs.push({ id: randomBytes(6).toString('hex'), time: new Date().toISOString(), message: clean, level });
    this.logs = this.logs.slice(-200); this.emit('change');
  }
  async connect(id, supplied, engine, retry = false) {
    if (this.session) throw new Error('Disconnect the current session first.');
    if (!engine.available) throw new Error('Run the DropoVPN installer again to restore the included OpenVPN engine, then check it in Settings.');
    const profile = this.store.profile(id);
    // Revalidate decrypted data before it ever crosses the privilege boundary.
    const proof = randomBytes(32).toString('hex');
    const config = normalizeProfile(this.store.config(id)).config + `echo dropovpn-peer:${proof}\n`;
    const credentials = supplied || this.store.credentials(id);
    if (profile.requiresAuth && !credentials) { this.update({ ...idle(), status: 'credentials-required', profileId: id, prompt: 'Auth', message: 'Enter your VPN credentials.' }); return; }
    if (credentials) { quoteManagement(credentials.username); quoteManagement(credentials.password); }
    if (!retry) this.retryCount = 0;
    const session = { id, engine, credentials, socket: null, server: null, child: null, timer: null, stopped: false, authenticated: false, hadConnection: retry, pendingRealm: null, privateKey: null, finishing: false, sockets: new Set() };
    this.session = session;
    this.update({ ...idle(), status: 'connecting', profileId: id, message: 'Approve the system prompt to create your tunnel.' });
    const token = randomBytes(32).toString('hex');
    const server = net.createServer(socket => this.accept(session, socket, token, proof)); session.server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.once('close', resolve); server.listen(0, '127.0.0.1', resolve); });
      if (session.stopped) { this.finish(session); return; }
      session.child = this.launch({ binary: engine.path, config, port: server.address().port, token });
      session.child.on('error', () => this.fail(session, 'The OpenVPN process could not be started. Check your engine installation.'));
      session.child.on('close', code => {
        if (this.session !== session) return;
        if (!session.stopped && session.hadConnection && this.store.data.settings.autoReconnect && code !== 1223 && code !== 1) { this.restart(session); return; }
        if (!session.stopped && code !== 0) this.update({ status: 'error', message: session.hadConnection ? 'The VPN process stopped. Connect again to restart it.' : 'OpenVPN could not start or administrator permission was declined. Check the profile and engine installation.' });
        this.finish(session);
      });
      session.child.stderr?.on('data', bytes => { if (String(bytes).includes('User canceled')) this.fail(session, 'Administrator permission was declined.'); });
      // Drain output; only sanitized management logs reach the UI.
      session.child.stdout?.resume();
      session.timer = setTimeout(() => this.fail(session, 'OpenVPN did not establish its control connection. Retry and approve the system prompt.'), this.startupTimeout);
    } catch (error) { this.fail(session, error.message); }
  }
  accept(session, socket, token, proof) {
    session.sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy());
    if (session.stopped || session.socket || this.session !== session) { socket.destroy(); return; }
    let buffer = '', tokenSent = false, passwordAccepted = false, authenticated = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 128 * 1024) { socket.destroy(); return; }
      if (!tokenSent && buffer.includes('ENTER PASSWORD:')) { socket.write(token + '\n'); tokenSent = true; buffer = buffer.replace('ENTER PASSWORD:', ''); }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!authenticated) {
          if (tokenSent && line.includes('SUCCESS: password is correct') && !passwordAccepted) {
            passwordAccepted = true; socket.write('echo all\n');
          }
          // A second, independent secret proves that the peer read our private
          // configuration. A process racing the loopback port cannot obtain VPN
          // credentials merely by accepting the management password we send.
          if (passwordAccepted && /^\d+,dropovpn-peer:/.test(line) && line.split(',')[1] === `dropovpn-peer:${proof}`) {
            if (session.socket || session.stopped) { socket.destroy(); return; }
            authenticated = true; session.authenticated = true; session.socket = socket;
            session.child?.cleanupStaging?.();
            socket.setTimeout(0); clearTimeout(session.timer);
            for (const other of session.sockets) if (other !== socket) other.destroy();
            this.command(session, 'state on'); this.command(session, 'bytecount 1'); this.command(session, 'log on'); this.command(session, 'hold off'); this.command(session, 'hold release');
            this.update({ message: 'Contacting your VPN server…' }); this.log('OpenVPN engine started.');
          }
          continue;
        }
        this.handle(session, parseLine(line));
      }
    });
    socket.on('close', () => {
      session.sockets.delete(socket);
      if (session.socket === socket && this.session === session && !session.stopped) {
        this.update({ status: 'reconnecting', connectedAt: null, localIp: null, message: 'The VPN engine stopped. Waiting for it to exit…' });
        // management-client exits on socket loss; give the elevated wrapper time
        // to report its exit before considering a new engine process.
        session.timer = setTimeout(() => this.fail(session, 'The VPN engine did not finish shutting down. Check the system prompt and try again.'), 10000);
      }
    });
  }
  command(session, command) { if (session.socket && !session.socket.destroyed) session.socket.write(command + '\n'); }
  handle(session, event) {
    if (!event || this.session !== session || session.stopped) return;
    if (event.type === 'state') {
      if (event.state === 'CONNECTED' && event.detail === 'SUCCESS') {
        session.hadConnection = true; this.retryCount = 0;
        this.update({ status: 'connected', connectedAt: new Date().toISOString(), localIp: event.localIp || null, remoteIp: event.remoteIp || null, message: 'Your VPN tunnel is connected.', prompt: null });
        this.log('VPN tunnel connected.');
      } else if (event.state === 'RECONNECTING') {
        if (!this.store.data.settings.autoReconnect && session.hadConnection) { void this.disconnect(); return; }
        this.update({ status: 'reconnecting', connectedAt: null, localIp: null, reconnects: this.state.reconnects + 1, message: 'Connection interrupted. Automatically reconnecting…' });
        this.log('Connection interrupted. Reconnecting with the current session.');
      } else if (event.state === 'EXITING') {
        this.update({ status: 'reconnecting', connectedAt: null, localIp: null, message: 'OpenVPN is restarting…' });
      } else if (!['credentials-required', 'reconnecting'].includes(this.state.status)) this.update({ message: event.state === 'AUTH' ? 'Authenticating with your VPN server…' : 'Establishing your VPN tunnel…' });
    } else if (event.type === 'traffic') this.update({ received: event.received, sent: event.sent });
    else if (event.type === 'password') {
      session.pendingRealm = event.realm;
      if (event.realm === 'Auth' && session.credentials) this.sendCredentials(session);
      else if (event.realm === 'Private Key' && session.privateKey) this.command(session, `password "Private Key" ${quoteManagement(session.privateKey)}`);
      else if (event.realm === 'Auth' || event.realm === 'Private Key') this.update({ status: 'credentials-required', prompt: event.realm, message: event.realm === 'Private Key' ? 'Enter the password for your client certificate.' : 'Enter your VPN credentials.' });
      else this.fail(session, 'This profile requests an unsupported authentication method. Use a username/password or certificate profile.');
    } else if (event.type === 'auth-failed') {
      session.credentials = null; session.privateKey = null;
      // Pause instead of repeatedly submitting a rejected saved password.
      this.command(session, 'hold on');
      this.update({ status: 'credentials-required', prompt: event.realm === 'Private Key' ? 'Private Key' : 'Auth', connectedAt: null, localIp: null, message: 'Sign-in was rejected. Enter updated credentials to try again.' });
      this.log('VPN sign-in rejected. Waiting for updated credentials.', 'warning');
    } else if (event.type === 'hold' && this.state.status !== 'credentials-required') this.command(session, 'hold release');
    else if (event.type === 'fatal') this.fail(session, safeLog(event.message, [session.credentials?.password, session.credentials?.username]) || 'OpenVPN reported a fatal error.');
    else if (event.type === 'unsupported-auth') this.fail(session, 'This server requires an interactive authentication method that this version does not support.');
    else if (event.type === 'log') this.log(event.message);
  }
  sendCredentials(session) {
    this.command(session, `username "Auth" ${quoteManagement(session.credentials.username)}`);
    this.command(session, `password "Auth" ${quoteManagement(session.credentials.password)}`);
    session.pendingRealm = null;
  }
  async submit({ username, password, remember, privateKey }, engine) {
    quoteManagement(password);
    const id = this.state.profileId;
    if (!id || this.state.status !== 'credentials-required') throw new Error('No sign-in is pending.');
    if (privateKey) {
      if (!this.session || this.state.prompt !== 'Private Key') throw new Error('No certificate password is pending.');
      this.session.privateKey = password;
      this.command(this.session, `password "Private Key" ${quoteManagement(password)}`);
    } else {
      quoteManagement(username);
      if (!username || !password) throw new Error('Enter a username and password.');
      const credentials = { username, password };
      if (remember) this.store.saveCredentials(id, credentials); else this.store.forget(id);
      if (!this.session) return this.connect(id, credentials, engine);
      this.session.credentials = credentials;
      if (this.session.pendingRealm === 'Auth') this.sendCredentials(this.session);
      this.command(this.session, 'hold off'); this.command(this.session, 'hold release');
    }
    this.update({ status: this.session?.hadConnection ? 'reconnecting' : 'connecting', prompt: null, message: 'Authenticating with your VPN server…' });
  }
  async disconnect() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    const session = this.session;
    if (!session) { this.update(idle()); return; }
    session.stopped = true; clearTimeout(session.timer);
    this.update({ status: 'disconnecting', prompt: null, message: 'Closing your VPN tunnel…' });
    this.command(session, 'signal SIGTERM');
    // management-client guarantees SIGTERM when this socket closes, including
    // when the Electron process crashes. Never kill only the elevation wrapper.
    for (const socket of session.sockets) socket.destroy();
    session.server?.close();
    await new Promise(resolve => {
      if (!session.child || session.child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 5000); session.child.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    this.finish(session);
  }
  fail(session, message) {
    if (this.session !== session) return;
    this.update({ status: 'error', message, connectedAt: null, prompt: null, localIp: null });
    session.stopped = true; clearTimeout(session.timer);
    for (const socket of session.sockets) socket.destroy();
    session.server?.close();
    this.log(message, 'error'); this.finish(session);
  }
  finish(session) {
    if (this.session !== session || session.finishing) return;
    session.finishing = true; clearTimeout(session.timer); session.server?.close();
    for (const socket of session.sockets) socket.destroy();
    session.credentials = null; session.privateKey = null; this.session = null;
    if (this.state.status !== 'error') this.update(idle());
    else this.emit('change');
  }
  restart(session) {
    const { id, credentials, engine } = session;
    session.stopped = true; this.finish(session);
    const delay = Math.min(30000, this.retryDelay * 2 ** this.retryCount++);
    this.update({ status: 'reconnecting', profileId: id, message: `Restarting the VPN engine in ${delay / 1000} seconds. System permission may be requested again.`, reconnects: this.retryCount });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.store.data.settings.autoReconnect) { this.update(idle()); return; }
      this.connect(id, credentials, engine, true).catch(error => this.update({ status: 'error', message: error.message }));
    }, delay);
  }
  resume() {
    if (this.session && !this.session.stopped && this.store.data.settings.autoReconnect && !this.state.prompt) {
      this.log('Computer resumed. Refreshing the VPN connection.');
      this.command(this.session, 'signal SIGUSR1');
    }
  }
}
