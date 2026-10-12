import fs from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { UPDATE_PUBLIC_KEY } from '../electron/update-key.mjs';

// Sign a release's SHA256SUMS.txt for the in-app updater. The private key
// comes from the UPDATE_SIGNING_KEY secret; the result must verify against the
// public key built into the app, so a mismatched key never ships a release.
const file = process.argv[2];
if (!file || !process.env.UPDATE_SIGNING_KEY) { console.error('Usage: UPDATE_SIGNING_KEY=… node scripts/sign-release.mjs release/SHA256SUMS.txt'); process.exit(1); }
const data = fs.readFileSync(file), signature = sign(null, data, createPrivateKey(process.env.UPDATE_SIGNING_KEY));
if (!verify(null, data, createPublicKey(UPDATE_PUBLIC_KEY), signature)) { console.error('UPDATE_SIGNING_KEY does not match the public key in electron/update-key.mjs.'); process.exit(1); }
fs.writeFileSync(`${file}.sig`, signature.toString('base64') + '\n');
console.log(`Signed ${file}.`);
