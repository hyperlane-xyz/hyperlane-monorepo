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
const { Wallet, providers, utils } = require('ethers');
const { MultiProvider, InterchainAccount } =
  await import('../../../sdk/dist/index.js');
const { CallCommitmentsService } =
  await import('../../src/services/CallCommitmentsService.ts');
const { registerRateLimiting } = await import('../../src/utils/rateLimit.ts');
const { createRpcServers, replyJson } = await import('../utils/rpcServer.ts');
const { offchainLookupRequestMessageHash } =
  await import('../../../sdk/dist/ism/utils.js');
const cert = fs.readFileSync(`${dir}/tls-cert.pem`);
const ca = fs.readFileSync(`${dir}/ca.pem`);
const base = 'https://127.0.0.1:55440/callCommitments';
const wallets = [1, 2, 3].map(
  (n) => new Wallet('0x' + n.toString().padStart(2, '0').repeat(32)),
);

// Local origin and destination chains. The origin answers each reveal's
// dispatch receipt and its router's mailbox; the destination router derives
// ICAs with the InterchainAccountRouter CREATE2 scheme.
const originDomain = 10;
const destinationDomain = 42161;
const originRouter = '0x' + '0a'.repeat(20);
const destinationRouter = '0x' + '0b'.repeat(20);
const mailbox = '0x' + '0c'.repeat(20);
const accountBytecodeHash = utils.id('ccs-e2e-account');
const routerInterface = new utils.Interface([
  'function mailbox() view returns (address)',
  'function bytecodeHash() view returns (bytes32)',
  'function isms(uint32) view returns (address)',
  'function getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32) view returns (address)',
]);
const mailboxInterface = new utils.Interface([
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
]);
function deriveIca(router, origin, owner, localRouter, ism, userSalt) {
  return utils.getCreate2Address(
    router,
    utils.solidityKeccak256(
      ['uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [origin, owner, localRouter, utils.hexZeroPad(ism, 32), userSalt],
    ),
    accountBytecodeHash,
  );
}
const receipts = new Map();
const rpcServers = createRpcServers();
function rpcResponder(chainRouter, handlers) {
  return (request, res) => {
    const reply = (result) =>
      replyJson(res, { jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'eth_blockNumber') return reply('0x10');
    if (request.method === 'eth_getTransactionReceipt') {
      return reply(
        receipts.get(String(request.params[0]).toLowerCase()) ?? null,
      );
    }
    if (request.method === 'eth_call') {
      const [call] = request.params;
      assert.equal(
        call.to.toLowerCase(),
        chainRouter,
        'Unexpected eth_call target',
      );
      const parsed = routerInterface.parseTransaction({ data: call.data });
      const handler = handlers[parsed.name];
      assert(handler, `Unexpected router call ${parsed.name}`);
      return reply(
        routerInterface.encodeFunctionResult(parsed.name, [
          handler(parsed.args),
        ]),
      );
    }
    replyJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Unsupported method ${request.method}` },
    });
  };
}
const originRpc = await rpcServers.start(
  rpcResponder(originRouter, { mailbox: () => mailbox }),
);
const destinationRpc = await rpcServers.start(
  rpcResponder(destinationRouter, {
    bytecodeHash: () => accountBytecodeHash,
    isms: () => utils.hexZeroPad('0x', 20),
    getLocalInterchainAccount: ([origin, owner, localRouter, ism, userSalt]) =>
      deriveIca(destinationRouter, origin, owner, localRouter, ism, userSalt),
  }),
);
const chain = (name, domainId, rpc) => ({
  name,
  chainId: domainId,
  domainId,
  protocol: 'ethereum',
  rpcUrls: [{ http: rpc }],
  nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
});
const provider = new MultiProvider(
  {
    ccsorigin: chain('ccsorigin', originDomain, originRpc),
    ccsdestination: chain('ccsdestination', destinationDomain, destinationRpc),
  },
  {
    providerBuilder: (metadata) =>
      new providers.StaticJsonRpcProvider(
        metadata.rpcUrls[0].http,
        metadata.chainId,
      ),
  },
);
const app = Fastify({ logger: true });
await registerRateLimiting(app);
new CallCommitmentsService(
  { serviceName: 'callCommitments', baseUrl: base, multiProvider: provider },
  InterchainAccount.fromAddressesMap(
    {
      ccsorigin: { interchainAccountRouter: originRouter },
      ccsdestination: { interchainAccountRouter: destinationRouter },
    },
    provider,
  ),
  wallets.slice(0, 2).map((w) => w.address),
  new Map([
    [originDomain, { interchainAccountRouter: originRouter }],
    [destinationDomain, { interchainAccountRouter: destinationRouter }],
  ]),
  true,
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
  svmAccount = '0x' + '04'.repeat(20),
  owner = utils.hexZeroPad('0x' + '06'.repeat(20), 32),
  userSalt = '0x' + '07'.repeat(32),
  zeroIsm = utils.hexZeroPad('0x', 32);
const evmIca = deriveIca(
  destinationRouter,
  originDomain,
  owner,
  utils.hexZeroPad(originRouter, 32),
  utils.hexZeroPad('0x', 20),
  userSalt,
);
function formatMessage(nonce, body) {
  return utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      3,
      nonce,
      originDomain,
      utils.hexZeroPad(originRouter, 32),
      destinationDomain,
      utils.hexZeroPad(destinationRouter, 32),
      body,
    ],
  );
}
function dispatchLog(message, logIndex, transactionHash) {
  const { data, topics } = mailboxInterface.encodeEventLog(
    mailboxInterface.getEvent('Dispatch'),
    [
      originRouter,
      destinationDomain,
      utils.hexZeroPad(destinationRouter, 32),
      message,
    ],
  );
  return {
    address: mailbox,
    blockHash: '0x' + '0d'.repeat(32),
    blockNumber: '0x1',
    data,
    logIndex: utils.hexValue(logIndex),
    removed: false,
    topics,
    transactionHash,
    transactionIndex: '0x0',
  };
}
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
  const isEvm = revealAccounts === undefined;
  const payload = {
    commitment,
    originDomain,
    data,
    salt,
    relayers,
    destinationAccount: utils.hexZeroPad(isEvm ? evmIca : svmAccount, 32),
    ...(revealAccounts ? { revealAccounts } : {}),
  };
  const uploaded = await request('/calldata', 'POST', payload);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  const revealBody = utils.hexConcat([
    '0x02',
    utils.hexZeroPad('0x00', 32),
    commitment,
  ]);
  const commitMessage = formatMessage(
    1,
    utils.hexConcat(['0x01', owner, zeroIsm, userSalt, commitment]),
  );
  const message = formatMessage(2, revealBody);
  const originTxHash = utils.id(`ccs-e2e-origin-tx-${name}`);
  if (isEvm) {
    receipts.set(originTxHash, {
      blockHash: '0x' + '0d'.repeat(32),
      blockNumber: '0x1',
      contractAddress: null,
      cumulativeGasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      from: wallets[0].address,
      gasUsed: '0x5208',
      logs: [
        dispatchLog(commitMessage, 0, originTxHash),
        dispatchLog(message, 1, originTxHash),
      ],
      logsBloom: '0x' + '00'.repeat(256),
      status: '0x1',
      to: originRouter,
      transactionHash: originTxHash,
      transactionIndex: '0x0',
      type: '0x2',
    });
  }
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
    expectedMetadata:
      (isEvm ? evmIca : svmAccount) + salt.slice(2) + data.slice(2),
    originTxHash: isEvm ? originTxHash : undefined,
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
for (const c of fixtures.cases.filter((c) => c.originTxHash)) {
  const signer = wallets[1];
  const signature = await signer.signMessage(
    utils.arrayify(
      offchainLookupRequestMessageHash(
        sender,
        c.lookupData,
        base + '/getCallsFromRevealMessage',
      ),
    ),
  );
  const revealed = await request('/getCallsFromRevealMessage', 'POST', {
    sender,
    data: c.lookupData,
    signature,
    origin_tx_hash: c.originTxHash,
  });
  assert.equal(revealed.status, 200, JSON.stringify(revealed));
  assert.equal(revealed.body.data, c.expectedMetadata);
}
fs.writeFileSync(`${dir}/fixtures.json`, JSON.stringify(fixtures, null, 2));
console.log(
  'READY: real PostgreSQL + HTTPS CCS; 4 uploads, unsigned/per-record checks and bound reveal lookups passed',
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => tlsServer.close(resolve));
  await app.close();
  await rpcServers.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
