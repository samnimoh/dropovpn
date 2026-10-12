// The shared DropoVPN relay. Its access key ships inside every installer, so it
// is public by design: the relay only connects mesh devices, whose traffic is
// end-to-end encrypted, and it serves no public URLs. Anyone who wants their
// own access control can run relay/server.mjs and switch to it in the app.
export const DEFAULT_RELAY = { url: 'wss://dropovpn.samuelnimoh.com/', token: 'zqjQAG7P4gHWa4L2z1fkVXfOk5jvHWJr' };
