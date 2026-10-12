const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke('dropovpn:' + channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('dropovpn', {
  snapshot: () => invoke('snapshot'),
  importProfiles: () => invoke('import'),
  remove: id => invoke('remove', id),
  rename: (id, name) => invoke('rename', id, name),
  forget: id => invoke('forget', id),
  connect: id => invoke('connect', id),
  disconnect: () => invoke('disconnect'),
  credentials: value => invoke('credentials', value),
  settings: value => invoke('settings', value),
  checkEngine: () => invoke('engine-check'),
  selectEngine: () => invoke('engine-select'),
  help: () => invoke('help'),
  clearLogs: () => invoke('clear-logs'),
  meshCreate: () => invoke('mesh-create'),
  meshJoin: invite => invoke('mesh-join', invite),
  meshLeave: () => invoke('mesh-leave'),
  meshInvite: () => invoke('mesh-invite'),
  meshSettings: value => invoke('mesh-settings', value),
  meshShare: value => invoke('mesh-share', value),
  meshUnshare: id => invoke('mesh-unshare', id),
  meshDetect: () => invoke('mesh-detect'),
  tunnelStart: value => invoke('tunnel-start', value),
  tunnelStop: id => invoke('tunnel-stop', id),
  tunnelTools: () => invoke('tunnel-tools'),
  openLink: url => invoke('open-link', url),
  copyLink: url => invoke('copy-link', url),
  onChange: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('dropovpn:changed', listener);
    return () => ipcRenderer.removeListener('dropovpn:changed', listener);
  }
});
