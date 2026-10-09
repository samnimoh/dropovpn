export type Profile = { id: string; name: string; server: string; protocol: string; requiresAuth: boolean; hasCredentials: boolean; createdAt: string };
export type Settings = { autoReconnect: boolean; launchAtLogin: boolean; minimizeToTray: boolean; enginePath: string };
export type Connection = { status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'credentials-required' | 'disconnecting' | 'error'; profileId: string | null; connectedAt: string | null; localIp: string | null; remoteIp: string | null; received: number; sent: number; reconnects: number; message: string; prompt: string | null };
export type Engine = { available: boolean; path: string; version: string | null };
export type Snapshot = { profiles: Profile[]; settings: Settings; connection: Connection; logs: { id: string; time: string; message: string; level: string }[]; engine: Engine; platform: string; vaultAvailable: boolean; version: string };
export type API = {
  snapshot(): Promise<Snapshot>; importProfiles(): Promise<string[]>; remove(id: string): Promise<void>; rename(id: string, name: string): Promise<void>;
  forget(id: string): Promise<void>; connect(id: string): Promise<void>; disconnect(): Promise<void>;
  credentials(value: { username: string; password: string; remember: boolean; privateKey: boolean }): Promise<void>;
  settings(value: Partial<Settings>): Promise<void>; checkEngine(): Promise<Engine>; selectEngine(): Promise<void>; help(): Promise<void>; clearLogs(): Promise<void>;
  onChange(callback: (state: Snapshot) => void): () => void;
};
declare global { interface Window { dropovpn?: API } }
