// Disposable, generated-on-demand test keys only. Never import production PEMs.
import { generateKeyPairSync, sign, verify, constants } from 'node:crypto';
import { writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !statSync(directory).isDirectory())
  throw new Error('Pass an existing empty fixture directory');
const write = (name, bytes) =>
  writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const signingKey = {
  key: rsa.privateKey,
  padding: constants.RSA_PKCS1_PADDING,
};
const message = Buffer.from('hyperlane-zig-rs256-fixture');
const signature = sign('RSA-SHA256', message, signingKey);
if (!verify('RSA-SHA256', message, rsa.publicKey, signature))
  throw new Error('Independent signature verification failed');
const header = Buffer.from(
  JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' }),
).toString('base64url');
const claims = Buffer.from(
  JSON.stringify({
    iss: 'fixture@project.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1000,
    exp: 4600,
  }),
).toString('base64url');
const signingInput = `${header}.${claims}`;
const jwtSignature = sign('RSA-SHA256', Buffer.from(signingInput), signingKey);
if (
  !verify('RSA-SHA256', Buffer.from(signingInput), rsa.publicKey, jwtSignature)
)
  throw new Error('Independent JWT verification failed');
write('private.pem', rsa.privateKey);
write('public.pem', rsa.publicKey);
write('message.bin', message);
write('signature.bin', signature);
write('jwt.txt', `${signingInput}.${jwtSignature.toString('base64url')}`);
const accessClaims = Buffer.from(
  JSON.stringify({
    iss: 'fixture@project.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    sub: 'fixture@project.iam.gserviceaccount.com',
    iat: 1000,
    exp: 4600,
  }),
).toString('base64url');
const accessInput = `${header}.${accessClaims}`;
const accessSignature = sign(
  'RSA-SHA256',
  Buffer.from(accessInput),
  signingKey,
);
if (
  !verify(
    'RSA-SHA256',
    Buffer.from(accessInput),
    rsa.publicKey,
    accessSignature,
  )
)
  throw new Error('Independent access JWT verification failed');
write(
  'access-jwt.txt',
  `${accessInput}.${accessSignature.toString('base64url')}`,
);
write(
  'service-account.json',
  JSON.stringify({
    type: 'service_account',
    project_id: 'fixture-project',
    private_key_id: 'fixture-key',
    private_key: rsa.privateKey,
    client_email: 'fixture@project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
);
write(
  'rsa1024.pem',
  generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
);
write(
  'ec-private.pem',
  generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
);
