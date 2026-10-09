import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) env.DROPOVPN_DEV = '1';
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('close', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
