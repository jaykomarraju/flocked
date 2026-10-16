#!/usr/bin/env node
// Generates a VAPID key pair (P-256, RFC 8292) for web push and writes it into a .dev.vars file
// (default apps/api/.dev.vars), replacing any VAPID_* lines there. The private key is never printed;
// the public key is, since the web app needs it as its applicationServerKey. Deployed environments
// get their own pair from the owner (OA-12): `wrangler secret put VAPID_PRIVATE_KEY --env <env>`.
//
//   node scripts/gen-vapid.mjs [path/to/.dev.vars]
//   VAPID_SUBJECT=mailto:ops@flocked.xyz node scripts/gen-vapid.mjs e2e/stack/.dev.vars
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2] ?? 'apps/api/.dev.vars';
const subject = process.env.VAPID_SUBJECT ?? 'mailto:ops@flocked.xyz';

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const { d } = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'base64url',
);

const kept = existsSync(target)
  ? readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => !/^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=/.test(line))
  : [];
while (kept.length > 0 && kept.at(-1) === '') kept.pop();
kept.push(
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_KEY=${d}`,
  `VAPID_SUBJECT=${subject}`,
  '',
);
writeFileSync(target, kept.join('\n'), { mode: 0o600 });
console.log(`Wrote a new VAPID key pair to ${target}.`);
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
