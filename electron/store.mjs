import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory, encryption) {
    this.directory = directory; this.encryption = encryption;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'dropovpn.json');
    this.data = { version: 1, profiles: [], secrets: {}, settings: { autoReconnect: true, launchAtLogin: false, minimizeToTray: true, enginePath: '' } };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.profiles)) throw new Error('Unrecognized DropoVPN data format.');
      this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...saved.settings } };
    }
  }
  persist() {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  seal(value) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('The operating system credential store is unavailable. Unlock your keychain and try again.');
    return this.encryption.encryptString(JSON.stringify(value)).toString('base64');
  }
  unseal(value) { return JSON.parse(this.encryption.decryptString(Buffer.from(value, 'base64'))); }
  list() { return this.data.profiles.map(({ encryptedConfig, ...profile }) => ({ ...profile, hasCredentials: !!this.data.secrets[profile.id] })); }
  profile(id) { const p = this.data.profiles.find(p => p.id === id); if (!p) throw new Error('Profile not found.'); return p; }
  config(id) { return this.unseal(this.profile(id).encryptedConfig); }
  add(name, parsed) {
    const { config, ...metadata } = parsed;
    const profile = { id: randomUUID(), name: name.slice(0, 80), ...metadata, createdAt: new Date().toISOString(), encryptedConfig: this.seal(config) };
    this.data.profiles.push(profile); this.persist(); return profile.id;
  }
  remove(id) { this.profile(id); this.data.profiles = this.data.profiles.filter(p => p.id !== id); delete this.data.secrets[id]; this.persist(); }
  credentials(id) { this.profile(id); return this.data.secrets[id] ? this.unseal(this.data.secrets[id]) : null; }
  saveCredentials(id, credentials) { this.profile(id); this.data.secrets[id] = this.seal(credentials); this.persist(); }
  forget(id) { this.profile(id); delete this.data.secrets[id]; this.persist(); }
  settings(update) {
    for (const key of ['autoReconnect', 'launchAtLogin', 'minimizeToTray']) {
      if (key in update) { if (typeof update[key] !== 'boolean') throw new Error('Invalid setting.'); this.data.settings[key] = update[key]; }
    }
    this.persist();
  }
}
