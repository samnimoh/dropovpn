export type Profile = { id: string; name: string; server: string; protocol: string; requiresAuth: boolean; hasCredentials: boolean; createdAt: string };
export type Settings = { autoReconnect: boolean; launchAtLogin: boolean; minimizeToTray: boolean; autoUpdate: boolean; enginePath: string };
export type Update = { status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'; current: string; version: string | null; notes: string | null; progress: number; message: string; checkedAt: string | null; manual: boolean; enabled: boolean; dismissed: boolean; result: { ok: boolean; version: string } | null };
export type Connection = { status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'credentials-required' | 'disconnecting' | 'error'; profileId: string | null; connectedAt: string | null; localIp: string | null; remoteIp: string | null; received: number; sent: number; reconnects: number; message: string; prompt: string | null };
export type Engine = { available: boolean; path: string; version: string | null; bundled?: boolean };
export type Protocol = 'http' | 'https' | 'tcp';
export type SharedService = { id: string; name: string; host: string; port: number; protocol: Protocol };
export type PeerService = { id: string; name: string; port: number; protocol: Protocol; localPort: number | null; error: string };
export type Peer = { id: string; name: string; platform: string; online: boolean; path: 'direct' | 'relay' | null; lastSeen: string | null; services: PeerService[] };
export type Mesh = { configured: boolean; enabled: boolean; deviceName: string; lanDiscovery: boolean; relayURL: string; defaultRelayURL: string; hasRelayToken: boolean; services: SharedService[]; port: number | null; listenError: string; relay: { status: 'off' | 'connecting' | 'connected' | 'error'; message: string; publicTunnels: boolean }; peers: Peer[] };
export type Provider = 'cloudflared' | 'ngrok' | 'relay';
export type Tool = { available: boolean; path?: string; version?: string | null; reason?: string };
export type Tunnel = { id: string; provider: Provider; target: string; url: string | null; status: 'starting' | 'online' | 'reconnecting' | 'error'; message: string; startedAt: string };
export type Tunnels = { tools: Record<Provider, Tool>; list: Tunnel[] };
export type Snapshot = { profiles: Profile[]; settings: Settings; connection: Connection; logs: { id: string; time: string; message: string; level: string }[]; engine: Engine; platform: string; vaultAvailable: boolean; version: string; mesh: Mesh; tunnels: Tunnels; update: Update };
export type API = {
  snapshot(): Promise<Snapshot>; importProfiles(): Promise<string[]>; remove(id: string): Promise<void>; rename(id: string, name: string): Promise<void>;
  forget(id: string): Promise<void>; connect(id: string): Promise<void>; disconnect(): Promise<void>;
  credentials(value: { username: string; password: string; remember: boolean; privateKey: boolean }): Promise<void>;
  settings(value: Partial<Settings>): Promise<void>; checkEngine(): Promise<Engine>; selectEngine(): Promise<void>; help(): Promise<void>; clearLogs(): Promise<void>;
  meshCreate(): Promise<void>; meshJoin(invite: string): Promise<void>; meshLeave(): Promise<void>; meshInvite(): Promise<void>;
  meshSettings(value: { enabled?: boolean; deviceName?: string; lanDiscovery?: boolean; relayURL?: string; relayToken?: string }): Promise<void>;
  meshShare(value: { target: string; name: string }): Promise<void>; meshUnshare(id: string): Promise<void>; meshDetect(): Promise<number[]>;
  tunnelStart(value: { provider: Provider; target: string; name?: string }): Promise<string>; tunnelStop(id: string): Promise<void>; tunnelTools(): Promise<void>;
  openLink(url: string): Promise<void>; copyLink(url: string): Promise<void>;
  updateCheck(): Promise<void>; updateDownload(): Promise<void>; updateInstall(): Promise<void>; updateDismiss(): Promise<void>; updateResultDismiss(): Promise<void>; updateNotes(): Promise<void>;
  onChange(callback: (state: Snapshot) => void): () => void;
};
declare global { interface Window { dropovpn?: API } }
