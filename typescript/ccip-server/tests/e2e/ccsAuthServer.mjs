import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = process.env.CCS_E2E_DIR;
assert(dir, 'Set CCS_E2E_DIR to the fixture directory');
assert(
  process.env.DATABASE_URL,
  'Set DATABASE_URL to a disposable local ccs_e2e database',
);
const database = new URL(process.env.DATABASE_URL);
assert(
  ['localhost', '127.0.0.1'].includes(database.hostname) &&
    database.pathname === '/ccs_e2e',
  'Only a local ccs_e2e database is allowed',
);
const { default: Fastify } = await import(require.resolve('fastify'));
const { Wallet, utils } = require('ethers');
const { MultiProvider, InterchainAccount } =
  await import('../../../sdk/dist/index.js');
const { CallCommitmentsService } =
  await import('../../src/services/CallCommitmentsService.ts');
const { registerRateLimiting } = await import('../../src/utils/rateLimit.ts');
const { offchainLookupRequestMessageHash } =
  await import('../../../sdk/dist/ism/utils.js');
const cert = fs.readFileSync(`${dir}/tls-cert.pem`);
const ca = fs.readFileSync(`${dir}/ca.pem`);
const base = 'https://127.0.0.1:55440/callCommitments';
const wallets = [1, 2, 3].map(
  (n) => new Wallet('0x' + n.toString().padStart(2, '0').repeat(32)),
);
const provider = new MultiProvider({});
const app = Fastify({ logger: true });
await registerRateLimiting(app);
new CallCommitmentsService(
  { serviceName: 'callCommitments', baseUrl: base, multiProvider: provider },
  new InterchainAccount({}, provider),
  wallets.slice(0, 2).map((w) => w.address),
).registerRoutes(app, '/callCommitments');
await app.listen({ host: '127.0.0.1', port: 55441 });
const tlsServer = https.createServer(
  { key: fs.readFileSync(`${dir}/tls-key.pem`), cert },
  (req, res) => {
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 55441,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    req.pipe(upstream);
  },
);
await new Promise((resolve) => tlsServer.listen(55440, '127.0.0.1', resolve));
function request(path, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      base + path,
      {
        method,
        ca,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const sender = '0x' + '03'.repeat(20),
  ica = '0x' + '04'.repeat(20);
const evmData = utils.defaultAbiCoder.encode(
  ['tuple(bytes32 to,uint256 value,bytes data)[]'],
  [
    [
      {
        to: utils.hexZeroPad('0x' + '05'.repeat(20), 32),
        value: 0,
        data: '0x12345678',
      },
    ],
  ],
);
const fixtures = {
  base,
  ca: `${dir}/ca.pem`,
  sender,
  wallets: wallets.map((w) => w.address),
  cases: [],
};
for (const [name, data, saltByte, relayers] of [
  ['evm', evmData, '11', []],
  ['svm', '0xdeadbeefcafebabe', '22', []],
  ['restrictedEvm', evmData, '33', [wallets[1].address]],
  ['restrictedSvm', '0xdeadbeefcafebabe', '44', [wallets[1].address]],
]) {
  const salt = '0x' + saltByte.repeat(32);
  const commitment = utils.keccak256(utils.concat([salt, data]));
  const revealAccounts = name.toLowerCase().includes('svm')
    ? [
        {
          pubkey: '11111111111111111111111111111111',
          isWritable: false,
          isSigner: false,
        },
      ]
    : undefined;
  const payload = {
    commitment,
    originDomain: 10,
    data,
    salt,
    relayers,
    destinationAccount: utils.hexZeroPad(ica, 32),
    ...(revealAccounts ? { revealAccounts } : {}),
  };
  const uploaded = await request('/calldata', 'POST', payload);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  const revealBody = utils.hexConcat([
    '0x02',
    utils.hexZeroPad('0x00', 32),
    commitment,
  ]);
  const message = utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      3,
      1,
      10,
      utils.hexZeroPad('0x01', 32),
      42161,
      utils.hexZeroPad(ica, 32),
      revealBody,
    ],
  );
  const lookupData =
    utils.id('getCallsFromRevealMessage(bytes)').slice(0, 10) +
    utils.defaultAbiCoder.encode(['bytes'], [message]).slice(2);
  const signatures = [];
  for (const wallet of wallets) {
    const hash = offchainLookupRequestMessageHash(
      wallet.address,
      commitment,
      base + '/calldata',
    );
    signatures.push({
      address: wallet.address,
      hash,
      signature: await wallet.signMessage(utils.arrayify(hash)),
    });
  }
  fixtures.cases.push({
    name,
    commitment,
    data,
    salt,
    revealAccounts,
    lookupData,
    expectedMetadata: ica + salt.slice(2) + data.slice(2),
    signatures,
  });
}
const first = fixtures.cases[0];
assert.equal((await request('/calldata/' + first.commitment)).status, 401);
assert.equal(
  (
    await request('/getCallsFromRevealMessage', 'POST', {
      sender,
      data: first.lookupData,
    })
  ).status,
  401,
);
for (const c of fixtures.cases) {
  const s = c.signatures[0];
  const response = await request(
    '/calldata/' + c.commitment,
    'GET',
    undefined,
    {
      Authorization: 'Hyperlane-Signature ' + s.signature,
      'X-Hyperlane-Sender': s.address,
    },
  );
  assert.equal(
    response.status,
    c.name.startsWith('restricted') ? 403 : 200,
    JSON.stringify(response),
  );
  if (response.status === 200) {
    assert.equal(response.body.data, c.data);
    assert.equal(response.body.salt, c.salt);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
}
fs.writeFileSync(`${dir}/fixtures.json`, JSON.stringify(fixtures, null, 2));
console.log(
  'READY: real PostgreSQL + HTTPS CCS; 4 uploads and unsigned/per-record checks passed',
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => tlsServer.close(resolve));
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
