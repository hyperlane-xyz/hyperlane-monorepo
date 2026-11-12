import { expect } from 'chai';
import { BigNumber, Wallet, ethers, providers, utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type AccountConfig,
  InterchainAccount,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk/ism/utils';
import {
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import {
  addressToBytes32,
  assert,
  bytes32ToAddress,
  formatMessage,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { prisma } from '../../src/db.js';
import {
  CallCommitmentsService,
  type IcaRouters,
} from '../../src/services/CallCommitmentsService.js';
import { registerRateLimiting } from '../../src/utils/rateLimit.js';

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
  { calldataLookupEnabled = true }: { calldataLookupEnabled?: boolean } = {},
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

  it('rejects malformed origin transaction hints instead of serving stored routing metadata', async () => {
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
      for (const originTxHash of ['0x1234', '']) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data, signature, origin_tx_hash: originTxHash },
        });

        expect(response.statusCode).to.equal(400);
        expect(response.json().error).to.equal('Invalid origin_tx_hash');
      }
      expect(fetch.called).to.be.false;
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

  async function fixture({
    trustRouters = true,
    registeredWithDispatchedRouters = false,
    commitOwner = wallet.address,
    originV3Only = false,
    destinationV3Only = false,
    commitIsm = '0x' + '00'.repeat(20),
  }: {
    trustRouters?: boolean;
    registeredWithDispatchedRouters?: boolean;
    commitOwner?: string;
    originV3Only?: boolean;
    destinationV3Only?: boolean;
    commitIsm?: string;
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
        [2, salt, commitment],
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
    // Candidates for a destination without a V2 router read the router's ISM
    // for the origin.
    const destinationIsms: { error?: Error } = {};
    const destinationCall = sinon
      .stub(destinationProvider, 'call')
      .callsFake(async (transaction) => {
        const [to, data] = await Promise.all([
          transaction.to,
          transaction.data,
        ]);
        assert(to && data, 'Expected a router call');
        if (data.startsWith(routerInterface.getSighash('isms'))) {
          if (destinationIsms.error !== undefined) throw destinationIsms.error;
          return utils.defaultAbiCoder.encode(
            ['bytes32'],
            ['0x' + '00'.repeat(32)],
          );
        }
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
      });
    const multiProvider = sinon.createStubInstance(MultiProvider);
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
    const app = await server([wallet.address], {
      multiProvider,
      icaApp,
      trustedIcaRouters,
      originMailboxes: new Map([
        [8453, mailbox],
        [42161, '0x' + '34'.repeat(20)],
      ]),
    });
    const data =
      CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
        'getCallsFromRevealMessage',
        [message],
      );
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    const payload = { sender, data, signature, origin_tx_hash: originTxHash };
    return {
      app,
      payload,
      receipt,
      logs,
      icaApp,
      originCall,
      destinationCall,
      destinationIsms,
      originRouterV3,
      destinationRouterV3,
      record,
      updateMany,
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
      sinon.assert.calledOnce(f.destinationCall);
      sinon.assert.notCalled(f.originCall);
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

  it('returns HTTP 500 for a null origin transaction hash', async () => {
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
      expect(response.statusCode).to.equal(500);
      expect(response.json()).to.deep.equal({
        error: 'Missing origin transaction hash for reveal message',
      });
      sinon.assert.notCalled(f.receipt);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

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
  const v3CommitIsm = '0x' + '35'.repeat(20);

  it('serves a reveal to a destination whose registry lists only a V3 router, deriving its candidates from that router', async () => {
    // The record was registered without an ISM, so only the candidate that
    // reads the router's ISM for the origin matches.
    const f = await fixture({
      destinationV3Only: true,
      commitIsm: v3CommitIsm,
      registeredWithDispatchedRouters: true,
    });
    const servedIca = fakeAccount({
      origin: 'base',
      owner: wallet.address,
      userSalt: f.salt,
      localRouter: f.originRouterV3,
      routerOverride: f.destinationRouterV3,
      ismOverride: v3CommitIsm,
    });
    expect(servedIca).not.to.equal(f.record.ica);
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        servedIca + encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      expect(f.icaApp.getAccount.called).to.equal(false);
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
      const f = await fixture();
      f.icaApp.getAccount.callsFake(async (_destination, config) => {
        if (config.routerOverride === f.destinationRouterV3) throw error();
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
      name: 'returns HTTP 500, not a denial, when a candidate ICA read is unavailable and none matches',
      options: {},
      setup: (f) => {
        f.icaApp.getAccount.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'Could not derive every ICA candidate for the reveal',
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
      name: 'returns HTTP 403 when a destination with only a V3 router answers its candidate as underivable',
      options: {
        destinationV3Only: true,
        commitIsm: v3CommitIsm,
        registeredWithDispatchedRouters: true,
      },
      setup: (f) => {
        f.destinationIsms.error = missingSelector();
      },
      statusCode: 403,
      error: 'Reveal does not belong to this commitment',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 500 when a destination with only a V3 router cannot be read for its candidate',
      options: {
        destinationV3Only: true,
        commitIsm: v3CommitIsm,
        registeredWithDispatchedRouters: true,
      },
      setup: (f) => {
        f.destinationIsms.error = unavailableRpc();
      },
      statusCode: 500,
      error: 'Could not derive every ICA candidate for the reveal',
      readsReceipt: true,
      readsChain: true,
    },
    {
      name: 'returns HTTP 500 when the dispatched router pair cannot be read',
      options: {},
      setup: (f) => {
        f.destinationCall.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'missing response',
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

  for (const failure of ['missing receipt', 'origin RPC failure'] as const) {
    it(`returns HTTP 500 for ${failure}, without a successful metadata response`, async () => {
      const f = await fixture();
      if (failure === 'missing receipt') f.receipt.resolves(null);
      else f.receipt.rejects(new Error('origin RPC unavailable'));
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(500);
        expect(response.json()).to.deep.equal({
          error:
            failure === 'missing receipt'
              ? `Transaction not found: ${originTxHash}`
              : 'origin RPC unavailable',
        });
        sinon.assert.notCalled(f.destinationCall);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }
});
