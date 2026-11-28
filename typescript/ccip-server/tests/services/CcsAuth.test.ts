import { expect } from 'chai';
import { BigNumber, Wallet, ethers, providers, utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  CommitmentReadIsmService__factory,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IRoutingIsm__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type AccountConfig,
  InterchainAccount,
  ModuleType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk/ism/utils';
import {
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import {
  ProtocolType,
  addressToBytes32,
  assert,
  bytes32ToAddress,
  formatMessage,
  isNullish,
  isZeroishAddress,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../../src/db.js';
import {
  CallCommitmentsService,
  type IcaRouters,
} from '../../src/services/CallCommitmentsService.js';
import { registerRateLimiting } from '../../src/utils/rateLimit.js';
import { nonCanonicalCallData } from '../utils/abiHandler.js';

const origin = 'https://ccs.example';
const path = '/callCommitments/calldata/0x' + '11'.repeat(32);
const wallet = new Wallet('0x' + '01'.repeat(32));
const other = new Wallet('0x' + '02'.repeat(32));
const sender = '0x' + '03'.repeat(20);
const postPath = '/callCommitments/getCallsFromRevealMessage';
const data =
  CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
    'getCallsFromRevealMessage',
    ['0x1234'],
  );

async function headers(
  signer = wallet,
  commitment = '0x' + '11'.repeat(32),
  baseUrl = origin,
  claimedSender = signer.address,
) {
  const signature = await signer.signMessage(
    utils.arrayify(
      offchainLookupRequestMessageHash(
        claimedSender,
        commitment,
        baseUrl + '/callCommitments/calldata',
      ),
    ),
  );
  return {
    authorization: `Hyperlane-Signature ${signature}`,
    'x-hyperlane-sender': claimedSender,
  };
}

const defaultIcaRouters: ReadonlyMap<number, IcaRouters> = new Map([
  [1, { interchainAccountRouter: '0x' + '0a'.repeat(20) }],
]);
const defaultOriginMailboxes: ReadonlyMap<number, string> = new Map([
  [1, '0x' + '0c'.repeat(20)],
]);

/** Distinct, deterministic account per derivation input. */
function fakeAccount(config: AccountConfig): string {
  return utils.getAddress(
    utils.hexDataSlice(
      utils.id(
        JSON.stringify([
          config.origin,
          config.owner,
          config.userSalt,
          config.localRouter,
          config.routerOverride,
          config.ismOverride ?? null,
        ]).toLowerCase(),
      ),
      12,
    ),
  );
}

async function server(
  authorizedSigners: string[] = [wallet.address],
  dependencies?: {
    multiProvider: MultiProvider;
    icaApp: InterchainAccount;
    trustedIcaRouters: ReadonlyMap<number, IcaRouters>;
    originMailboxes: ReadonlyMap<number, string>;
  },
  {
    calldataLookupEnabled = true,
    sealevelRevealsEnabled = false,
  }: { calldataLookupEnabled?: boolean; sealevelRevealsEnabled?: boolean } = {},
) {
  const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
  await registerRateLimiting(app);
  const service = new CallCommitmentsService(
    {
      serviceName: 'callCommitments',
      baseUrl: origin + '/callCommitments',
      multiProvider:
        dependencies?.multiProvider ?? sinon.createStubInstance(MultiProvider),
    },
    dependencies?.icaApp ?? sinon.createStubInstance(InterchainAccount),
    authorizedSigners,
    dependencies?.trustedIcaRouters ?? defaultIcaRouters,
    calldataLookupEnabled,
    dependencies?.originMailboxes ?? defaultOriginMailboxes,
    sealevelRevealsEnabled,
  );
  service.registerRoutes(app, '/callCommitments');
  return app;
}

describe('CCS read authentication', () => {
  afterEach(() => sinon.restore());

  it('does not register the calldata lookup when it is disabled, for any signer', async () => {
    const db = sinon.stub();
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server([wallet.address], undefined, {
      calldataLookupEnabled: false,
    });
    try {
      for (const requestHeaders of [
        {},
        await headers(),
        await headers(other),
      ]) {
        expect(
          (
            await app.inject({
              method: 'GET',
              url: path,
              headers: requestHeaders,
            })
          ).statusCode,
        ).to.equal(404);
      }
      expect(db.called).to.equal(false);
    } finally {
      await app.close();
    }
  });

  it('requires an allowed signer before reading calldata, even with an empty record allowlist', async () => {
    const db = sinon.stub().resolves({
      originDomain: 1,
      data: '0x1234',
      salt: '0x00',
      relayers: [],
      destinationAccount: '0x1234',
      revealAccounts: null,
      createdAt: new Date(),
      commitment: '0x' + '11'.repeat(32),
    });
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (await app.inject({ method: 'GET', url: path })).statusCode,
      ).to.equal(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(other),
          })
        ).statusCode,
      ).to.equal(403);
      expect(db.called).to.equal(false);
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: await headers(),
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal('0x1234');
      expect(response.headers['cache-control']).to.equal('no-store');
      const lowerCaseHeaders = await headers();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: {
              ...lowerCaseHeaders,
              authorization: lowerCaseHeaders.authorization.replace(
                'Hyperlane-Signature',
                'hyperlane-signature',
              ),
            },
          })
        ).statusCode,
      ).to.equal(200);
    } finally {
      await app.close();
    }
  });

  it('enforces per-commitment restrictions on top of the global whitelist', async () => {
    const db = sinon.stub().resolves({
      originDomain: 1,
      data: '0x1234',
      salt: '0x00',
      relayers: [other.address],
      destinationAccount: '0x1234',
      revealAccounts: null,
      createdAt: new Date(),
      commitment: '0x' + '11'.repeat(32),
    });
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(),
          })
        ).statusCode,
      ).to.equal(403);
    } finally {
      await app.close();
    }
  });

  it('rejects tampered, cross-service, non-EVM, and query-string-only credentials', async () => {
    const db = sinon.stub();
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(wallet, undefined, origin, other.address),
          })
        ).statusCode,
      ).to.equal(401);
      for (const requestHeaders of [
        await headers(wallet, '0x' + '22'.repeat(32)),
        await headers(wallet, undefined, 'https://other.example'),
        { ...(await headers()), 'x-hyperlane-sender': other.address },
        {
          ...(await headers()),
          authorization: 'Hyperlane-Signature 0xgarbage',
        },
        { ...(await headers()), authorization: 'Hyperlane-Ed25519 invalid' },
        {
          ...(await headers()),
          'x-hyperlane-sender': 'G5FM3UKwcBJ47PwLWLLY1RQpqNtTMgnqnd6nZGcJqaBp',
        },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: path,
          headers: requestHeaders,
        });
        expect([401, 403]).to.include(response.statusCode);
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path + '?sender=' + wallet.address + '&signature=0x1234',
          })
        ).statusCode,
      ).to.equal(401);
      expect(db.called).to.equal(false);
    } finally {
      await app.close();
    }
  });

  it('accepts the existing POST body signature and restricts it to the global whitelist', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: postPath,
            payload: { sender, data },
          })
        ).statusCode,
      ).to.equal(401);
      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, signature },
      });
      expect(response.statusCode).to.equal(200);
      expect(fetch.lastCall.args[1]).to.equal(wallet.address.toLowerCase());
      for (const payload of [
        { sender: other.address, data, signature },
        { sender, data: data + '00', signature },
        {
          sender,
          data,
          signature: await other.signMessage(
            utils.arrayify(
              offchainLookupRequestMessageHash(sender, data, origin + postPath),
            ),
          ),
        },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: postPath, payload }))
            .statusCode,
        ).to.equal(403);
      }
      expect(fetch.callCount).to.equal(1);
    } finally {
      await app.close();
    }
  });

  it('builds reveal call data in its canonical ABI encoding', () => {
    expect(data).to.equal(
      '0x2b4b00ee' +
        '00'.repeat(31) +
        '20' +
        '00'.repeat(31) +
        '02' +
        '1234' +
        '00'.repeat(30),
    );
  });

  for (const c of nonCanonicalCallData(data)) {
    it(`rejects signed reveal call data with ${c.name}`, async () => {
      const fetch = sinon
        .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
        .resolves('0x1234');
      const app = await server();
      const signature = await wallet.signMessage(
        utils.arrayify(
          offchainLookupRequestMessageHash(sender, c.data, origin + postPath),
        ),
      );
      try {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data: c.data, signature },
        });
        expect(response.statusCode).to.equal(400);
        expect(response.json()).to.deep.equal({
          error: 'Non-canonical callData',
        });
        sinon.assert.notCalled(fetch);
      } finally {
        await app.close();
      }
    });
  }

  it('accepts signed canonical reveal call data in upper-case hex', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const upperCaseData = '0x' + data.slice(2).toUpperCase();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(
          sender,
          upperCaseData,
          origin + postPath,
        ),
      ),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data: upperCaseData, signature },
      });
      expect(response.statusCode).to.equal(200);
      sinon.assert.calledOnce(fetch);
      expect(fetch.firstCall.args[0]).to.equal('0x1234');
    } finally {
      await app.close();
    }
  });

  it('forwards the signed lookup sender of a reveal request in lower case', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const lookupSender = '0x' + 'ab'.repeat(20);
    const checksummedSender = utils.getAddress(lookupSender);
    expect(checksummedSender).to.not.equal(lookupSender);
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(
          checksummedSender,
          data,
          origin + postPath,
        ),
      ),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender: checksummedSender, data, signature },
      });
      expect(response.statusCode).to.equal(200);
      sinon.assert.calledOnce(fetch);
      expect(fetch.firstCall.args[4]).to.equal(lookupSender);
    } finally {
      await app.close();
    }
  });

  it('forwards the origin transaction hash only after authenticating a reveal request', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const originTxHash = '0x' + '34'.repeat(32);
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, origin_tx_hash: originTxHash },
      });
      expect(unauthenticated.statusCode).to.equal(401);
      expect(fetch.called).to.be.false;

      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, signature, origin_tx_hash: originTxHash },
      });

      expect(response.statusCode).to.equal(200);
      expect(fetch.calledOnce).to.be.true;
      expect(fetch.firstCall.args[3]).to.equal(originTxHash);
    } finally {
      await app.close();
    }
  });

  it('forwards string origin transaction hints for protocol-aware validation', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      for (const originTxHash of ['0x1234', '', '0x' + 'ab'.repeat(64)]) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data, signature, origin_tx_hash: originTxHash },
        });

        expect(response.statusCode).to.equal(200);
        expect(fetch.lastCall.args[3]).to.equal(originTxHash);
      }
      expect(fetch.callCount).to.equal(3);
    } finally {
      await app.close();
    }
  });

  it('treats null and non-string origin transaction hints as absent', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      for (const originTxHash of [null, 1234, false, {}]) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data, signature, origin_tx_hash: originTxHash },
        });
        expect(response.statusCode).to.equal(200);
        expect(fetch.lastCall.args[3]).to.equal(undefined);
      }
    } finally {
      await app.close();
    }
  });

  it('denies all reads with an empty whitelist', async () => {
    const app = await server([]);
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(),
          })
        ).statusCode,
      ).to.equal(403);
    } finally {
      await app.close();
    }
  });
});

describe('CCS authenticated reveal recovery integration', () => {
  afterEach(() => sinon.restore());

  const originTxHash = '0x' + '34'.repeat(32);
  const blockHash = '0x' + '37'.repeat(32);

  function receiptWith(logs: providers.Log[]): providers.TransactionReceipt {
    return {
      to: '0x' + '38'.repeat(20),
      from: wallet.address,
      contractAddress: '0x' + '00'.repeat(20),
      transactionIndex: 0,
      gasUsed: BigNumber.from(21_000),
      logsBloom: '0x' + '00'.repeat(256),
      blockHash,
      transactionHash: originTxHash,
      logs,
      blockNumber: 1,
      confirmations: 1,
      cumulativeGasUsed: BigNumber.from(21_000),
      effectiveGasPrice: BigNumber.from(1),
      byzantium: true,
      type: 2,
      status: 1,
    };
  }

  const missingSelector = () =>
    ethers.logger.makeError(
      'call revert exception',
      ethers.errors.CALL_EXCEPTION,
      { data: '0x' },
    );
  const unavailableRpc = () =>
    new Error('missing response', {
      cause: ethers.logger.makeError(
        'missing response',
        ethers.errors.SERVER_ERROR,
        {},
      ),
    });

  const FakeIsmKind = {
    Routing: 'routing',
    Aggregation: 'aggregation',
    Module: 'module',
    Reverts: 'reverts',
    Unavailable: 'unavailable',
  } as const;

  type FakeIsmFailure =
    | typeof FakeIsmKind.Reverts
    | typeof FakeIsmKind.Unavailable;

  /** How a destination ISM answers the reads of the reveal ISM walk. */
  type FakeIsm =
    | { kind: typeof FakeIsmKind.Routing; route: string }
    | { kind: typeof FakeIsmKind.Aggregation; modules: string[] }
    | { kind: typeof FakeIsmKind.Module; moduleType: ModuleType }
    | { kind: typeof FakeIsmKind.Reverts }
    | { kind: typeof FakeIsmKind.Unavailable };

  const ccipReadIsm: FakeIsm = {
    kind: FakeIsmKind.Module,
    moduleType: ModuleType.CCIP_READ,
  };
  const multisigIsm: FakeIsm = {
    kind: FakeIsmKind.Module,
    moduleType: ModuleType.MESSAGE_ID_MULTISIG,
  };

  async function fixture({
    trustRouters = true,
    registeredWithDispatchedRouters = false,
    commitOwner = wallet.address,
    originV3Only = false,
    destinationV3Only = false,
    commitIsm = '0x' + '00'.repeat(20),
    protocol = ProtocolType.Ethereum,
    sealevelRevealsEnabled = false,
    revealIsm = '0x' + '00'.repeat(20),
    lookupSender = sender,
    isms = {},
    recipientIsmFailure,
    commitmentDelivered = true,
    deliveredFailure,
    destinationProtocol = ProtocolType.Ethereum,
  }: {
    trustRouters?: boolean;
    registeredWithDispatchedRouters?: boolean;
    commitOwner?: string;
    originV3Only?: boolean;
    destinationV3Only?: boolean;
    commitIsm?: string;
    protocol?: ProtocolType | null;
    sealevelRevealsEnabled?: boolean;
    /** The ISM field of the reveal; zero routes to the router's default. */
    revealIsm?: string;
    lookupSender?: string;
    /** Destination ISMs by address; `sender` is the router's default ISM. */
    isms?: Record<string, FakeIsm>;
    /** How the destination mailbox's `recipientIsm` read fails, if it does. */
    recipientIsmFailure?: FakeIsmFailure;
    /** Whether the destination mailbox reports the commitment as delivered. */
    commitmentDelivered?: boolean;
    /** How the destination mailbox's `delivered` read fails, if it does. */
    deliveredFailure?: FakeIsmFailure;
    /** The protocol of the reveal's destination (domain 42161). */
    destinationProtocol?: ProtocolType;
  } = {}) {
    const originRouter = '0x' + '31'.repeat(20);
    const destinationRouter = '0x' + '32'.repeat(20);
    const originRouterV3 = '0x' + '51'.repeat(20);
    const destinationRouterV3 = '0x' + '52'.repeat(20);
    const mailbox = '0x' + '33'.repeat(20);
    const salt = '0x' + '00'.repeat(32);
    const calls = [{ to: sender, value: '0', data: '0x' }];
    const commitment = commitmentFromIcaCalls(normalizeCalls(calls), salt);
    const committedMessage = formatMessage(
      3,
      10,
      8453,
      originRouterV3,
      42161,
      destinationRouterV3,
      utils.solidityPack(
        ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [
          1,
          addressToBytes32(commitOwner),
          utils.hexZeroPad(commitIsm, 32),
          salt,
          commitment,
        ],
      ),
    );
    const message = formatMessage(
      3,
      11,
      8453,
      originRouterV3,
      42161,
      destinationRouterV3,
      utils.solidityPack(
        ['uint8', 'bytes32', 'bytes32'],
        [2, utils.hexZeroPad(revealIsm, 32), commitment],
      ),
    );
    const mailboxInterface = Mailbox__factory.createInterface();
    const logs = [committedMessage, message].map(
      (raw, logIndex): providers.Log => {
        const { data, topics } = mailboxInterface.encodeEventLog(
          mailboxInterface.getEvent('Dispatch'),
          [originRouterV3, 42161, addressToBytes32(destinationRouterV3), raw],
        );
        return {
          blockNumber: 1,
          blockHash,
          transactionIndex: 0,
          removed: false,
          address: mailbox,
          data,
          topics,
          transactionHash: originTxHash,
          logIndex,
        };
      },
    );
    const originProvider = new providers.JsonRpcProvider();
    const destinationProvider = new providers.JsonRpcProvider();
    const receipt = sinon
      .stub(originProvider, 'getTransactionReceipt')
      .resolves(receiptWith(logs));
    const originCall = sinon
      .stub(originProvider, 'call')
      .rejects(new Error('Unexpected origin call'));
    // The dispatched router pair derives with the same model as the registry
    // candidates below, so every ICA depends on the commit's owner and salt.
    const routerInterface = InterchainAccountRouter__factory.createInterface();
    const deriveIca = sinon.spy();
    function answerRouter(to: string, data: string): string {
      const parsed = routerInterface.parseTransaction({ data });
      if (parsed.name === 'moduleType') {
        return routerInterface.encodeFunctionResult('moduleType', [
          ModuleType.ROUTING,
        ]);
      }
      // Mirrors `InterchainAccountRouter.route` for a reveal: its ISM field,
      // or the router's default ISM (`sender`) when zero.
      if (parsed.name === 'route') {
        const routed = bytes32ToAddress(
          utils.hexDataSlice(parseMessage(parsed.args[0]).body, 1, 33),
        );
        return routerInterface.encodeFunctionResult('route', [
          isZeroishAddress(routed) ? sender : routed,
        ]);
      }
      deriveIca();
      const [, owner, router, ism, userSalt] =
        routerInterface.decodeFunctionData(
          'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
          data,
        );
      return utils.defaultAbiCoder.encode(
        ['address'],
        [
          fakeAccount({
            origin: 'base',
            owner: bytes32ToAddress(owner),
            userSalt,
            localRouter: bytes32ToAddress(router),
            routerOverride: to,
            ismOverride: isZeroishAddress(ism) ? undefined : ism,
          }),
        ],
      );
    }
    const fakeIsms = new Map<string, FakeIsm>(
      Object.entries(isms).map(([address, ism]) => [
        address.toLowerCase(),
        ism,
      ]),
    );
    if (!fakeIsms.has(sender)) fakeIsms.set(sender, ccipReadIsm);
    const ismInterface = IInterchainSecurityModule__factory.createInterface();
    const routingInterface = IRoutingIsm__factory.createInterface();
    const aggregationInterface = IAggregationIsm__factory.createInterface();
    const ismReads = new Map<string, number>();
    function answerIsm(to: string, data: string): string {
      ismReads.set(to, (ismReads.get(to) ?? 0) + 1);
      const ism = fakeIsms.get(to);
      if (!ism || ism.kind === FakeIsmKind.Reverts) throw missingSelector();
      if (ism.kind === FakeIsmKind.Unavailable) throw unavailableRpc();
      if (
        utils.hexDataSlice(data, 0, 4) === ismInterface.getSighash('moduleType')
      ) {
        const moduleType =
          ism.kind === FakeIsmKind.Routing
            ? ModuleType.ROUTING
            : ism.kind === FakeIsmKind.Aggregation
              ? ModuleType.AGGREGATION
              : ism.moduleType;
        return ismInterface.encodeFunctionResult('moduleType', [moduleType]);
      }
      if (ism.kind === FakeIsmKind.Routing) {
        routingInterface.decodeFunctionData('route', data);
        return routingInterface.encodeFunctionResult('route', [ism.route]);
      }
      if (ism.kind === FakeIsmKind.Aggregation) {
        aggregationInterface.decodeFunctionData('modulesAndThreshold', data);
        return aggregationInterface.encodeFunctionResult(
          'modulesAndThreshold',
          [ism.modules, 1],
        );
      }
      throw missingSelector();
    }
    const destinationMailbox = '0x' + '34'.repeat(20);
    const deliveredIds: string[] = [];
    function answerMailbox(data: string): string {
      const parsed = mailboxInterface.parseTransaction({ data });
      if (parsed.name === 'delivered') deliveredIds.push(parsed.args[0]);
      const failure =
        parsed.name === 'delivered' ? deliveredFailure : recipientIsmFailure;
      if (failure === FakeIsmKind.Reverts) throw missingSelector();
      if (failure === FakeIsmKind.Unavailable) throw unavailableRpc();
      if (parsed.name === 'delivered') {
        return mailboxInterface.encodeFunctionResult('delivered', [
          commitmentDelivered,
        ]);
      }
      // The ICA router names itself as its recipient ISM.
      return mailboxInterface.encodeFunctionResult('recipientIsm', [
        parsed.args[0],
      ]);
    }
    const destinationCall = sinon
      .stub(destinationProvider, 'call')
      .callsFake(async (transaction) => {
        const [to, rawData] = await Promise.all([
          transaction.to,
          transaction.data,
        ]);
        assert(to && rawData, 'Expected a destination call');
        const target = to.toLowerCase();
        const data = utils.hexlify(rawData);
        if (target === destinationMailbox) return answerMailbox(data);
        if (target === destinationRouter || target === destinationRouterV3) {
          return answerRouter(to, data);
        }
        return answerIsm(target, data);
      });
    const multiProvider = sinon.createStubInstance(MultiProvider);
    if (protocol === null) {
      multiProvider.getProtocol.withArgs(8453).throws('Unknown origin');
    } else {
      multiProvider.getProtocol.withArgs(8453).returns(protocol);
    }
    multiProvider.getProtocol.withArgs(42161).returns(destinationProtocol);
    multiProvider.getChainName.withArgs(8453).returns('base');
    multiProvider.getChainName.withArgs(42161).returns('arbitrum');
    multiProvider.getProvider.withArgs('base').returns(originProvider);
    multiProvider.getProvider.withArgs(42161).returns(destinationProvider);
    const icaApp = sinon.createStubInstance(InterchainAccount);
    icaApp.getAccount.callsFake(async (_destination, config) =>
      fakeAccount(config),
    );
    // Dispatched through the V3 pair; records registered without router
    // overrides store the V2-derived ICA.
    const v2Ica = fakeAccount({
      origin: 'base',
      owner: wallet.address,
      userSalt: salt,
      localRouter: originRouter,
      routerOverride: destinationRouter,
    });
    const dispatchedIca = fakeAccount({
      origin: 'base',
      owner: wallet.address,
      userSalt: salt,
      localRouter: originRouterV3,
      routerOverride: destinationRouterV3,
      ismOverride: isZeroishAddress(commitIsm) ? undefined : commitIsm,
    });
    const record = {
      commitment,
      calls,
      salt,
      ica: registeredWithDispatchedRouters ? dispatchedIca : v2Ica,
      originDomain: 8453,
      relayers: [wallet.address],
    };
    const findUnique = sinon.stub().resolves(record);
    const updateMany = sinon.stub().resolves({ count: 1 });
    sinon.stub(prisma, 'commitment').value({ findUnique, updateMany });
    const trustedIcaRouters: ReadonlyMap<number, IcaRouters> = trustRouters
      ? new Map([
          [
            8453,
            originV3Only
              ? { interchainAccountRouterV3: originRouterV3 }
              : {
                  interchainAccountRouter: originRouter,
                  interchainAccountRouterV3: originRouterV3,
                },
          ],
          [
            42161,
            destinationV3Only
              ? { interchainAccountRouterV3: destinationRouterV3 }
              : {
                  interchainAccountRouter: destinationRouter,
                  interchainAccountRouterV3: destinationRouterV3,
                },
          ],
        ])
      : new Map([
          [8453, { interchainAccountRouter: '0x' + '41'.repeat(20) }],
          [42161, { interchainAccountRouter: '0x' + '42'.repeat(20) }],
        ]);
    const app = await server(
      [wallet.address],
      {
        multiProvider,
        icaApp,
        trustedIcaRouters,
        originMailboxes: new Map([
          [8453, mailbox],
          [42161, destinationMailbox],
        ]),
      },
      { sealevelRevealsEnabled },
    );
    const data =
      CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
        'getCallsFromRevealMessage',
        [message],
      );
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(lookupSender, data, origin + postPath),
      ),
    );
    const payload = {
      sender: lookupSender,
      data,
      signature,
      origin_tx_hash: originTxHash,
    };
    return {
      app,
      payload,
      receipt,
      logs,
      icaApp,
      originCall,
      destinationCall,
      deriveIca,
      ismReads,
      deliveredIds,
      commitmentMessageId: messageId(committedMessage),
      revealMessageId: messageId(message),
      destinationRouter,
      destinationRouterV3,
      record,
      updateMany,
      findUnique,
      dispatchedIca,
      v2Ica,
      salt,
      calls,
      commitment,
    };
  }

  it("authenticates and serves the dispatched V3 pair's ICA for a record that stores the V2-derived ICA, without database writes", async () => {
    const f = await fixture();
    expect(f.dispatchedIca).not.to.equal(f.v2Ica);
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.dispatchedIca +
          encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      sinon.assert.notCalled(f.updateMany);
      sinon.assert.calledOnce(f.receipt);
      sinon.assert.calledOnce(f.deriveIca);
      sinon.assert.notCalled(f.originCall);
    } finally {
      await f.app.close();
    }
  });

  it('serves the dispatched ICA without deriving router version candidates when it is the stored one', async () => {
    const f = await fixture({ registeredWithDispatchedRouters: true });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.dispatchedIca +
          encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      expect(f.icaApp.getAccount.called).to.equal(false);
      sinon.assert.calledOnce(f.deriveIca);
    } finally {
      await f.app.close();
    }
  });

  it('serves a reveal from an origin whose registry lists only a V3 router, reading only its receipt from the origin chain', async () => {
    const f = await fixture({
      originV3Only: true,
      registeredWithDispatchedRouters: true,
    });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.dispatchedIca +
          encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      sinon.assert.calledOnce(f.receipt);
      sinon.assert.notCalled(f.originCall);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

  it('returns HTTP 400 for a null origin transaction hash', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: {
          sender: f.payload.sender,
          data: f.payload.data,
          signature: f.payload.signature,
          origin_tx_hash: null,
        },
      });
      expect(response.statusCode).to.equal(400);
      expect(response.json()).to.deep.equal({
        error: 'Invalid origin_tx_hash',
      });
      sinon.assert.notCalled(f.receipt);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

  interface OriginProtocolCase {
    protocol: ProtocolType | null;
    sealevelRevealsEnabled: boolean;
  }

  const originProtocolCases: OriginProtocolCase[] = [
    { protocol: ProtocolType.Ethereum, sealevelRevealsEnabled: false },
    { protocol: ProtocolType.Ethereum, sealevelRevealsEnabled: true },
    { protocol: ProtocolType.Sealevel, sealevelRevealsEnabled: true },
    { protocol: ProtocolType.Sealevel, sealevelRevealsEnabled: false },
    { protocol: ProtocolType.Cosmos, sealevelRevealsEnabled: true },
    { protocol: null, sealevelRevealsEnabled: true },
  ];

  for (const { protocol, sealevelRevealsEnabled } of originProtocolCases) {
    for (const { originTxHash, validEvmHash } of [
      { originTxHash: undefined, validEvmHash: false },
      { originTxHash: null, validEvmHash: false },
      { originTxHash: 1234, validEvmHash: false },
      { originTxHash: '', validEvmHash: false },
      { originTxHash: '0x1234', validEvmHash: false },
      { originTxHash: '0x' + 'ab'.repeat(32), validEvmHash: true },
      { originTxHash: '0x' + 'ab'.repeat(64), validEvmHash: false },
    ]) {
      it(`handles ${protocol ?? 'unknown'} origin with hash ${JSON.stringify(originTxHash)} when Sealevel reveals are ${sealevelRevealsEnabled ? 'enabled' : 'disabled'}`, async () => {
        const f = await fixture({ protocol, sealevelRevealsEnabled });
        const isEvm = protocol === ProtocolType.Ethereum;
        const isSealevel = protocol === ProtocolType.Sealevel;
        const status = isSealevel
          ? sealevelRevealsEnabled
            ? 200
            : 403
          : isEvm
            ? validEvmHash
              ? 200
              : 400
            : 500;
        try {
          const response = await f.app.inject({
            method: 'POST',
            url: postPath,
            payload: {
              sender: f.payload.sender,
              data: f.payload.data,
              signature: f.payload.signature,
              origin_tx_hash: originTxHash,
            },
          });
          expect(response.statusCode).to.equal(status);
          if (status === 200) {
            const ica = isSealevel ? f.record.ica : f.dispatchedIca;
            expect(response.json().data).to.equal(
              ica + encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
            );
          } else {
            expect(response.json()).to.deep.equal({
              error:
                status === 400
                  ? 'Invalid origin_tx_hash'
                  : status === 403
                    ? 'Sealevel-origin reveals are disabled'
                    : 'Internal server error',
            });
          }
          expect(f.receipt.callCount).to.equal(isEvm && validEvmHash ? 1 : 0);
          sinon.assert.notCalled(f.updateMany);
        } finally {
          await f.app.close();
        }
      });
    }
  }

  it('serves a reveal to a destination without a V2 router from the dispatched ICA alone', async () => {
    const f = await fixture({
      destinationV3Only: true,
      registeredWithDispatchedRouters: true,
    });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.dispatchedIca +
          encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      expect(f.icaApp.getAccount.called).to.equal(false);
      sinon.assert.calledOnce(f.deriveIca);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

  for (const [name, error] of [
    ['the chain answers it as underivable', missingSelector],
    ['its read is unavailable', unavailableRpc],
  ] as const) {
    it(`serves the dispatched ICA when another candidate matches and one fails because ${name}`, async () => {
      // The V2 pair with the commit's ISM fails; the V2 pair with the
      // enrolled ISM derives the stored ICA.
      const f = await fixture({ commitIsm: '0x' + '35'.repeat(20) });
      f.icaApp.getAccount.callsFake(async (_destination, config) => {
        if (!isNullish(config.ismOverride)) throw error();
        return fakeAccount(config);
      });
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(200);
        expect(response.json().data).to.equal(
          f.dispatchedIca +
            encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
        );
        expect(
          f.icaApp.getAccount
            .getCalls()
            .map((call) => [
              call.args[1].routerOverride,
              call.args[1].ismOverride,
            ]),
        ).to.deep.equal([
          [f.destinationRouter, undefined],
          [f.destinationRouter, utils.hexZeroPad('0x' + '35'.repeat(20), 32)],
          [f.destinationRouterV3, undefined],
        ]);
      } finally {
        await f.app.close();
      }
    });
  }

  interface FailureCase {
    name: string;
    options: Parameters<typeof fixture>[0];
    setup?: (f: Awaited<ReturnType<typeof fixture>>) => void;
    statusCode: number;
    error: string;
    readsReceipt: boolean;
    readsChain: boolean;
  }

  const failureCases: FailureCase[] = [
    {
      name: 'returns HTTP 403 when the paired commit derives a different ICA than the stored one',
      options: { commitOwner: other.address },
      statusCode: 403,
      error: 'Reveal does not belong to this commitment',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 403 for routers not in the registry',
      options: { trustRouters: false, registeredWithDispatchedRouters: true },
      statusCode: 403,
      error: 'Reveal was not dispatched between known ICA routers',
      readsReceipt: false,
      readsChain: false,
    },
    {
      name: 'answers pending, not a denial, when a candidate ICA read is unavailable and none matches',
      options: {},
      setup: (f) => {
        f.icaApp.getAccount.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'Chain read is pending',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 403 when the chain answers every failed candidate as underivable and none matches',
      options: {},
      setup: (f) => {
        f.icaApp.getAccount.rejects(missingSelector());
      },
      statusCode: 403,
      error: 'Reveal does not belong to this commitment',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 403 for a destination without a V2 router when the dispatched ICA is not the stored one',
      options: { destinationV3Only: true },
      statusCode: 403,
      error: 'Reveal does not belong to this commitment',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'answers pending when the dispatched router pair cannot be read',
      options: {},
      setup: (f) => {
        f.destinationCall.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'Chain read is pending',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 403 when the chain answers that the dispatched router pair cannot derive the ICA',
      options: {},
      setup: (f) => {
        f.destinationCall.rejects(missingSelector());
      },
      statusCode: 403,
      error: 'Dispatched routers do not derive an ICA for the reveal',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 403 for a reveal from another origin than the stored one',
      options: {},
      setup: (f) => {
        f.record.originDomain = 10;
      },
      statusCode: 403,
      error: 'Reveal origin does not match stored commitment',
      readsReceipt: false,
      readsChain: false,
    },
    {
      name: 'returns HTTP 403 for a reveal with no commitment dispatched before it',
      options: {},
      setup: (f) => {
        f.receipt.resolves(receiptWith([f.logs[1]]));
      },
      statusCode: 403,
      error: 'Matching commitment dispatch not found',
      readsReceipt: true,
      readsChain: false,
    },
  ];

  for (const c of failureCases) {
    it(c.name, async () => {
      const f = await fixture(c.options);
      c.setup?.(f);
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(c.statusCode);
        expect(response.json()).to.deep.equal({ error: c.error });
        expect(f.receipt.called).to.equal(c.readsReceipt);
        expect(f.destinationCall.called).to.equal(c.readsChain);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }

  interface PendingCase {
    name: string;
    setup: (f: Awaited<ReturnType<typeof fixture>>) => void;
    error: string;
    readsReceipt: boolean;
  }

  const pendingCases: PendingCase[] = [
    {
      name: 'a commitment not uploaded yet',
      setup: (f) => {
        f.findUnique.resolves(null);
      },
      error: 'Commitment upload is pending',
      readsReceipt: false,
    },
    {
      name: 'a missing receipt',
      setup: (f) => {
        f.receipt.resolves(null);
      },
      error: 'Origin transaction receipt is pending',
      readsReceipt: true,
    },
    {
      name: 'an origin RPC failure',
      setup: (f) => {
        f.receipt.rejects(new Error('origin RPC unavailable'));
      },
      error: 'Chain read is pending',
      readsReceipt: true,
    },
  ];

  for (const c of pendingCases) {
    it(`answers pending for ${c.name}, without a successful metadata response`, async () => {
      const f = await fixture();
      c.setup(f);
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(500);
        expect(response.json()).to.deep.equal({ error: c.error });
        expect(f.receipt.called).to.equal(c.readsReceipt);
        sinon.assert.notCalled(f.destinationCall);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }

  const customLeaf = '0x' + '61'.repeat(20);
  const routingIsm = '0x' + '62'.repeat(20);
  const aggregationIsm = '0x' + '63'.repeat(20);
  const nestedMultisig = '0x' + '64'.repeat(20);
  const nestedLeaf = '0x' + '65'.repeat(20);
  const otherLeaf = '0x' + '66'.repeat(20);
  const ismAt = (index: number) =>
    utils.hexZeroPad(utils.hexlify(0x7000 + index), 20);

  const nestedTree: Record<string, FakeIsm> = {
    [routingIsm]: { kind: FakeIsmKind.Routing, route: aggregationIsm },
    [aggregationIsm]: {
      kind: FakeIsmKind.Aggregation,
      modules: [nestedMultisig, nestedLeaf],
    },
    [nestedMultisig]: multisigIsm,
    [nestedLeaf]: ccipReadIsm,
  };

  /** `length` routing ISMs, below the ICA router, ending in `customLeaf`. */
  function routingChain(length: number): Record<string, FakeIsm> {
    const isms: Record<string, FakeIsm> = { [customLeaf]: ccipReadIsm };
    for (let index = 0; index < length; index++) {
      isms[ismAt(index)] = {
        kind: FakeIsmKind.Routing,
        route: index + 1 < length ? ismAt(index + 1) : customLeaf,
      };
    }
    return isms;
  }

  /**
   * An aggregation of `multisigs` multisig ISMs and `customLeaf`, listing the
   * first multisig again before the leaf when `repeatFirst` is set.
   */
  function wideAggregation(
    multisigs: number,
    repeatFirst = false,
  ): Record<string, FakeIsm> {
    const modules = Array.from({ length: multisigs }, (_, index) =>
      ismAt(index),
    );
    const isms: Record<string, FakeIsm> = {
      [aggregationIsm]: {
        kind: FakeIsmKind.Aggregation,
        modules: [...modules, ...(repeatFirst ? [ismAt(0)] : []), customLeaf],
      },
      [customLeaf]: ccipReadIsm,
    };
    for (const module of modules) isms[module] = multisigIsm;
    return isms;
  }

  /**
   * An aggregation of `nestedLeaf` and a routing chain whose CCIP-read ISM
   * (`otherLeaf`) is beyond the walked depth.
   */
  function leafBesideDeepBranch(): Record<string, FakeIsm> {
    const isms: Record<string, FakeIsm> = {
      [aggregationIsm]: {
        kind: FakeIsmKind.Aggregation,
        modules: [ismAt(0), nestedLeaf],
      },
      [nestedLeaf]: ccipReadIsm,
      [otherLeaf]: ccipReadIsm,
    };
    for (let index = 0; index < 12; index++) {
      isms[ismAt(index)] = {
        kind: FakeIsmKind.Routing,
        route: index + 1 < 12 ? ismAt(index + 1) : otherLeaf,
      };
    }
    return isms;
  }

  interface IsmTreeCase {
    name: string;
    options: Parameters<typeof fixture>[0];
    statusCode: number;
    error?: string;
  }

  const notInTree = 'Lookup sender does not verify this reveal';
  const ismTreeCases: IsmTreeCase[] = [
    {
      name: "serves the router's default CCIP-read ISM for a reveal without an ISM",
      options: {},
      statusCode: 200,
    },
    {
      name: 'denies another CCIP-read ISM for a reveal without an ISM',
      options: { lookupSender: otherLeaf, isms: { [otherLeaf]: ccipReadIsm } },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'serves the CCIP-read ISM named in the reveal',
      options: {
        revealIsm: customLeaf,
        lookupSender: customLeaf,
        isms: { [customLeaf]: ccipReadIsm },
      },
      statusCode: 200,
    },
    {
      name: "denies the router's default ISM when the reveal names another",
      options: { revealIsm: customLeaf, isms: { [customLeaf]: ccipReadIsm } },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'serves a CCIP-read ISM nested in an aggregation behind routing',
      options: {
        revealIsm: routingIsm,
        lookupSender: nestedLeaf,
        isms: nestedTree,
      },
      statusCode: 200,
    },
    {
      name: 'denies a module of the tree that is not a CCIP-read ISM',
      options: {
        revealIsm: routingIsm,
        lookupSender: nestedMultisig,
        isms: nestedTree,
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'denies when the route read of a routing ISM reverts',
      options: {
        revealIsm: routingIsm,
        isms: {
          [routingIsm]: {
            kind: FakeIsmKind.Module,
            moduleType: ModuleType.ROUTING,
          },
        },
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'denies when the modules read of an aggregation ISM reverts',
      options: {
        revealIsm: aggregationIsm,
        isms: {
          [aggregationIsm]: {
            kind: FakeIsmKind.Module,
            moduleType: ModuleType.AGGREGATION,
          },
        },
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'serves a CCIP-read ISM beside a module whose reads revert',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: customLeaf,
        isms: {
          [aggregationIsm]: {
            kind: FakeIsmKind.Aggregation,
            modules: [routingIsm, customLeaf],
          },
          [routingIsm]: {
            kind: FakeIsmKind.Module,
            moduleType: ModuleType.ROUTING,
          },
          [customLeaf]: ccipReadIsm,
        },
      },
      statusCode: 200,
    },
    {
      name: 'denies a sender whose module type read reverts',
      options: { isms: { [sender]: { kind: FakeIsmKind.Reverts } } },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'answers pending, not a denial, when an ISM read is unavailable',
      options: { isms: { [sender]: { kind: FakeIsmKind.Unavailable } } },
      statusCode: 500,
      error: 'Chain read is pending',
    },
    {
      name: 'serves a CCIP-read ISM at the deepest walked depth (12)',
      options: {
        revealIsm: ismAt(0),
        lookupSender: customLeaf,
        isms: routingChain(11),
      },
      statusCode: 200,
    },
    {
      name: 'denies a CCIP-read ISM beyond the walked depth (13)',
      options: {
        revealIsm: ismAt(0),
        lookupSender: customLeaf,
        isms: routingChain(12),
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'serves a CCIP-read ISM beside a branch that goes beyond the walked depth',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: nestedLeaf,
        isms: leafBesideDeepBranch(),
      },
      statusCode: 200,
    },
    {
      name: 'denies the CCIP-read ISM of a branch beyond the walked depth',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: otherLeaf,
        isms: leafBesideDeepBranch(),
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'serves a CCIP-read ISM in a tree of 100 ISMs',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: customLeaf,
        isms: wideAggregation(97),
      },
      statusCode: 200,
    },
    {
      name: 'denies a CCIP-read ISM that would be the 101st ISM read',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: customLeaf,
        isms: wideAggregation(98),
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'counts a module listed twice once toward the 100 ISMs read',
      options: {
        revealIsm: aggregationIsm,
        lookupSender: customLeaf,
        isms: wideAggregation(97, true),
      },
      statusCode: 200,
    },
    {
      name: 'returns HTTP 500, not a denial, when the mailbox recipient ISM read reverts',
      options: { recipientIsmFailure: FakeIsmKind.Reverts },
      statusCode: 500,
      error: 'Internal server error',
    },
    {
      name: 'answers pending, not a denial, when the mailbox recipient ISM read is unavailable',
      options: { recipientIsmFailure: FakeIsmKind.Unavailable },
      statusCode: 500,
      error: 'Chain read is pending',
    },
    {
      name: 'denies a Sealevel-origin reveal to a CCIP-read ISM outside its tree',
      options: {
        protocol: ProtocolType.Sealevel,
        sealevelRevealsEnabled: true,
        lookupSender: otherLeaf,
        isms: { [otherLeaf]: ccipReadIsm },
      },
      statusCode: 403,
      error: notInTree,
    },
    {
      name: 'denies a Sealevel-origin reveal to a destination router not in the registry',
      options: {
        protocol: ProtocolType.Sealevel,
        sealevelRevealsEnabled: true,
        trustRouters: false,
      },
      statusCode: 403,
      error: 'Reveal was not dispatched to a known ICA router',
    },
  ];

  for (const c of ismTreeCases) {
    it(c.name, async () => {
      const f = await fixture(c.options);
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(c.statusCode);
        if (c.error === undefined) {
          expect(response.json().data).to.equal(
            f.dispatchedIca +
              encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
          );
        } else {
          expect(response.json()).to.deep.equal({ error: c.error });
        }
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }

  interface EarlyMatchCase {
    name: string;
    /** The aggregation's modules; `customLeaf` is the lookup sender. */
    modules: string[];
    isms: Record<string, FakeIsm>;
    statusCode: number;
    error?: string;
    /** ISMs the walk must not read. */
    unread: string[];
  }

  const unavailableIsm: FakeIsm = { kind: FakeIsmKind.Unavailable };
  const earlyMatchCases: EarlyMatchCase[] = [
    {
      name: 'serves the lookup sender without reading a later branch whose read is unavailable',
      modules: [customLeaf, routingIsm],
      isms: { [customLeaf]: ccipReadIsm, [routingIsm]: unavailableIsm },
      statusCode: 200,
      unread: [routingIsm],
    },
    {
      name: 'serves the lookup sender without walking a later branch',
      modules: [customLeaf, routingIsm],
      isms: {
        [customLeaf]: ccipReadIsm,
        [routingIsm]: { kind: FakeIsmKind.Routing, route: nestedLeaf },
        [nestedLeaf]: ccipReadIsm,
      },
      statusCode: 200,
      unread: [routingIsm, nestedLeaf],
    },
    {
      name: 'serves the lookup sender found after a branch whose read is unavailable',
      modules: [routingIsm, customLeaf],
      isms: { [customLeaf]: ccipReadIsm, [routingIsm]: unavailableIsm },
      statusCode: 200,
      unread: [],
    },
    {
      name: 'answers pending when the lookup sender is not found and a branch read is unavailable',
      modules: [routingIsm, otherLeaf],
      isms: { [otherLeaf]: ccipReadIsm, [routingIsm]: unavailableIsm },
      statusCode: 500,
      error: 'Chain read is pending',
      unread: [],
    },
  ];

  for (const c of earlyMatchCases) {
    it(c.name, async () => {
      const isms: Record<string, FakeIsm> = {
        [aggregationIsm]: { kind: FakeIsmKind.Aggregation, modules: c.modules },
      };
      for (const [address, ism] of Object.entries(c.isms)) isms[address] = ism;
      const f = await fixture({
        revealIsm: aggregationIsm,
        lookupSender: customLeaf,
        isms,
      });
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(c.statusCode);
        if (c.error === undefined) {
          expect(response.json().data).to.equal(
            f.dispatchedIca +
              encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
          );
        } else {
          expect(response.json()).to.deep.equal({ error: c.error });
        }
        for (const ism of c.unread) {
          expect(f.ismReads.get(ism) ?? 0, ism).to.equal(0);
        }
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }

  it('answers pending when the walk limit is reached after a branch read was unavailable', async () => {
    const isms = wideAggregation(98);
    isms[ismAt(0)] = unavailableIsm;
    const f = await fixture({
      revealIsm: aggregationIsm,
      lookupSender: customLeaf,
      isms,
    });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(500);
      expect(response.json()).to.deep.equal({
        error: 'Chain read is pending',
      });
      expect(f.ismReads.get(customLeaf) ?? 0).to.equal(0);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

  it('reads a routing ISM that routes to itself once', async () => {
    const f = await fixture({
      revealIsm: aggregationIsm,
      lookupSender: customLeaf,
      isms: {
        [aggregationIsm]: {
          kind: FakeIsmKind.Aggregation,
          modules: [routingIsm, customLeaf],
        },
        [routingIsm]: { kind: FakeIsmKind.Routing, route: routingIsm },
        [customLeaf]: ccipReadIsm,
      },
    });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(f.ismReads.get(routingIsm)).to.equal(2);
    } finally {
      await f.app.close();
    }
  });

  interface DeliveryCase {
    name: string;
    options: Parameters<typeof fixture>[0];
    setup?: (f: Awaited<ReturnType<typeof fixture>>) => void;
    statusCode: number;
    /** The response's `error`; the dispatched ICA is served when absent. */
    error?: string;
    /** Whether the paired commitment's delivery is queried. */
    readsDelivery: boolean;
  }

  const deliveryCases: DeliveryCase[] = [
    {
      name: 'answers pending while the paired commitment is not delivered',
      options: { commitmentDelivered: false },
      statusCode: 500,
      error: 'Commitment delivery is pending',
      readsDelivery: true,
    },
    {
      name: 'serves the reveal once the paired commitment is delivered',
      options: {},
      statusCode: 200,
      readsDelivery: true,
    },
    {
      name: 'answers pending when the delivery read is unavailable',
      options: { deliveredFailure: FakeIsmKind.Unavailable },
      statusCode: 500,
      error: 'Chain read is pending',
      readsDelivery: true,
    },
    {
      name: 'returns HTTP 500 when the delivery read reverts',
      options: { deliveredFailure: FakeIsmKind.Reverts },
      statusCode: 500,
      error: 'Internal server error',
      readsDelivery: true,
    },
    {
      name: 'denies a sender outside the ISM tree before reading delivery',
      options: {
        commitmentDelivered: false,
        lookupSender: otherLeaf,
        isms: { [otherLeaf]: ccipReadIsm },
      },
      statusCode: 403,
      error: notInTree,
      readsDelivery: false,
    },
    {
      name: 'denies an unauthorized relayer before reading delivery',
      options: { commitmentDelivered: false },
      setup: (f) => {
        f.record.relayers = [other.address];
      },
      statusCode: 403,
      error: 'Signer not authorized for this commitment',
      readsDelivery: false,
    },
  ];

  for (const c of deliveryCases) {
    it(c.name, async () => {
      const f = await fixture(c.options);
      c.setup?.(f);
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(c.statusCode);
        if (c.error === undefined) {
          expect(response.json().data).to.equal(
            f.dispatchedIca +
              encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
          );
        } else {
          expect(response.json()).to.deep.equal({ error: c.error });
        }
        expect(f.deliveredIds).to.deep.equal(
          c.readsDelivery ? [f.commitmentMessageId] : [],
        );
        expect(f.deliveredIds).to.not.include(f.revealMessageId);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }

  it('serves a Sealevel-origin reveal without reading commitment delivery', async () => {
    const f = await fixture({
      protocol: ProtocolType.Sealevel,
      sealevelRevealsEnabled: true,
      commitmentDelivered: false,
    });
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.record.ica + encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      expect(f.deliveredIds).to.deep.equal([]);
    } finally {
      await f.app.close();
    }
  });

  interface DestinationProtocolCase {
    name: string;
    options: Parameters<typeof fixture>[0];
    statusCode: number;
    /** The response's `error`; the dispatched ICA is served when absent. */
    error?: string;
    /** Whether the walk and the delivery read reach the destination. */
    readsDestination: boolean;
  }

  const destinationProtocolCases: DestinationProtocolCase[] = [
    {
      name: 'serves an EVM-origin reveal to a Tron destination',
      options: { destinationProtocol: ProtocolType.Tron },
      statusCode: 200,
      readsDestination: true,
    },
    {
      name: 'answers pending for a Tron destination until the commitment is delivered',
      options: {
        destinationProtocol: ProtocolType.Tron,
        commitmentDelivered: false,
      },
      statusCode: 500,
      error: 'Commitment delivery is pending',
      readsDestination: true,
    },
    {
      name: 'rejects a reveal to a destination that is not EVM-like',
      options: { destinationProtocol: ProtocolType.Cosmos },
      statusCode: 500,
      error: 'Internal server error',
      readsDestination: false,
    },
  ];

  for (const c of destinationProtocolCases) {
    it(c.name, async () => {
      const f = await fixture(c.options);
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(c.statusCode);
        if (c.error === undefined) {
          expect(response.json().data).to.equal(
            f.dispatchedIca +
              encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
          );
        } else {
          expect(response.json()).to.deep.equal({ error: c.error });
        }
        expect(f.ismReads.get(sender) ?? 0).to.equal(
          c.readsDestination ? 1 : 0,
        );
        expect(f.deliveredIds).to.deep.equal(
          c.readsDestination ? [f.commitmentMessageId] : [],
        );
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }
});
