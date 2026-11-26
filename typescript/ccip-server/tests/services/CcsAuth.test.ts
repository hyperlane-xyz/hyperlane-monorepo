import { expect } from 'chai';
import { BigNumber, Wallet, ethers, providers, utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';
import { z } from 'zod';

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
import {
  offchainLookupRequestHash,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk/ism/utils';
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
} from '@hyperlane-xyz/utils';

import { prisma } from '../../src/db.js';
import {
  CallCommitmentsService,
  CcsAuthMaxAgeSecondsSchema,
  type IcaRouters,
} from '../../src/services/CallCommitmentsService.js';
import { CcsAuthFailure } from '../../src/utils/ccsAuth.js';
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
  {
    calldataLookupEnabled = true,
    sealevelRevealsEnabled = false,
    authMaxAgeSeconds = 30,
    logs,
  }: {
    calldataLookupEnabled?: boolean;
    sealevelRevealsEnabled?: boolean;
    authMaxAgeSeconds?: number;
    /** Collects the server's warn and error log lines when given. */
    logs?: Record<string, unknown>[];
  } = {},
) {
  const app = Fastify({
    loggerInstance: logs
      ? pino(
          { level: 'warn' },
          {
            write: (line: string) => {
              logs.push(
                z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
              );
            },
          },
        )
      : pino({ level: 'silent' }),
  });
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
    authMaxAgeSeconds,
  );
  service.registerRoutes(app, '/callCommitments');
  return app;
}

/** The fields a v2 POST body carries next to its signature. */
interface V2Fields {
  sender: string;
  data: string;
  message_id: string;
  issued_at: number;
  origin_tx_hash: string;
}

function signV2(
  fields: V2Fields,
  signer = wallet,
  url = origin + postPath,
): Promise<string> {
  return signer.signMessage(
    utils.arrayify(
      offchainLookupRequestHash({
        urlTemplate: url,
        sender: fields.sender,
        callData: fields.data,
        messageId: fields.message_id,
        originTxHash: fields.origin_tx_hash,
        issuedAt: fields.issued_at,
      }),
    ),
  );
}

/** The id of the message revealed by `data`. */
const revealMessageId = messageId('0x1234');
const revealOriginTxHash = '0x' + '34'.repeat(32);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function v2Body(fields: V2Fields, signature: string): Record<string, unknown> {
  return {
    sender: fields.sender,
    data: fields.data,
    message_id: fields.message_id,
    issued_at: fields.issued_at,
    origin_tx_hash: fields.origin_tx_hash,
    signature,
  };
}

/** A v2-signed reveal body for `data`, issued now. */
async function signedReveal(
  fields: Pick<V2Fields, 'sender' | 'data' | 'origin_tx_hash'>,
  signer = wallet,
): Promise<Record<string, unknown>> {
  const v2: V2Fields = {
    sender: fields.sender,
    data: fields.data,
    message_id: revealMessageId,
    issued_at: nowSeconds(),
    origin_tx_hash: fields.origin_tx_hash,
  };
  return v2Body(v2, await signV2(v2, signer));
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

  it('rejects an unsigned POST body and restricts a v2 signature to the global whitelist', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const signedBody = await signedReveal({
      sender,
      data,
      origin_tx_hash: revealOriginTxHash,
    });
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
        payload: signedBody,
      });
      expect(response.statusCode).to.equal(200);
      expect(fetch.lastCall.args[1]).to.equal(wallet.address.toLowerCase());
      const otherSender = await signedReveal({
        sender,
        data,
        origin_tx_hash: revealOriginTxHash,
      });
      otherSender.sender = other.address;
      const otherData = await signedReveal({
        sender,
        data,
        origin_tx_hash: revealOriginTxHash,
      });
      otherData.data = data + '00';
      for (const payload of [
        otherSender,
        otherData,
        await signedReveal(
          { sender, data, origin_tx_hash: revealOriginTxHash },
          other,
        ),
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
        payload: await signedReveal({
          sender,
          data,
          origin_tx_hash: originTxHash,
        }),
      });

      expect(response.statusCode).to.equal(200);
      expect(fetch.calledOnce).to.be.true;
      expect(fetch.firstCall.args[3]).to.equal(originTxHash);
    } finally {
      await app.close();
    }
  });

  it('forwards signed non-empty hex origin transaction hints of any length for protocol-aware validation', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    try {
      for (const originTxHash of ['0x1234', '0x' + 'ab'.repeat(64)]) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: await signedReveal({
            sender,
            data,
            origin_tx_hash: originTxHash,
          }),
        });

        expect(response.statusCode).to.equal(200);
        expect(fetch.lastCall.args[3]).to.equal(originTxHash);
      }
      expect(fetch.callCount).to.equal(2);
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

describe('CCS v2 reveal authentication', () => {
  const now = 1_800_000_000;
  const originTxHash = '0x' + '34'.repeat(32);
  const signed: V2Fields = {
    sender,
    data,
    message_id: revealMessageId,
    issued_at: now,
    origin_tx_hash: originTxHash,
  };

  beforeEach(() => {
    sinon.useFakeTimers({ now: now * 1000, toFake: ['Date'] });
  });
  afterEach(() => sinon.restore());

  function stubFetch() {
    return sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
  }

  async function post(
    app: Awaited<ReturnType<typeof server>>,
    payload: Record<string, unknown>,
  ) {
    return app.inject({ method: 'POST', url: postPath, payload });
  }

  it('accepts a v2 signature and forwards the authenticated request', async () => {
    const fetch = stubFetch();
    const app = await server();
    try {
      const response = await post(app, v2Body(signed, await signV2(signed)));
      expect(response.statusCode).to.equal(200);
      sinon.assert.calledOnce(fetch);
      expect(fetch.firstCall.args[0]).to.equal('0x1234');
      expect(fetch.firstCall.args[1]).to.equal(wallet.address.toLowerCase());
      expect(fetch.firstCall.args[3]).to.equal(originTxHash);
    } finally {
      await app.close();
    }
  });

  it('accepts an upper-case signed message id', async () => {
    const fetch = stubFetch();
    const app = await server();
    const fields: V2Fields = {
      sender,
      data,
      message_id: '0x' + revealMessageId.slice(2).toUpperCase(),
      issued_at: now,
      origin_tx_hash: originTxHash,
    };
    try {
      const response = await post(app, v2Body(fields, await signV2(fields)));
      expect(response.statusCode).to.equal(200);
      sinon.assert.calledOnce(fetch);
    } finally {
      await app.close();
    }
  });

  interface FreshnessCase {
    name: string;
    issuedAt: number;
    authMaxAgeSeconds?: number;
    status: number;
  }
  const freshnessCases: FreshnessCase[] = [
    { name: 'exactly the max age old', issuedAt: now - 30, status: 200 },
    { name: 'older than the max age', issuedAt: now - 31, status: 401 },
    { name: 'at the clock skew limit', issuedAt: now + 5, status: 200 },
    { name: 'beyond the clock skew limit', issuedAt: now + 6, status: 401 },
    { name: 'from long ago', issuedAt: 0, status: 401 },
    {
      name: 'within a configured max age',
      issuedAt: now - 100,
      authMaxAgeSeconds: 120,
      status: 200,
    },
    {
      name: 'older than a configured max age',
      issuedAt: now - 121,
      authMaxAgeSeconds: 120,
      status: 401,
    },
    {
      name: 'older than a configured shorter max age',
      issuedAt: now - 11,
      authMaxAgeSeconds: 10,
      status: 401,
    },
  ];
  for (const c of freshnessCases) {
    it(`answers ${c.status} for a v2 signature ${c.name}`, async () => {
      const fetch = stubFetch();
      const app = await server(undefined, undefined, {
        authMaxAgeSeconds: c.authMaxAgeSeconds,
      });
      const fields: V2Fields = {
        sender,
        data,
        message_id: revealMessageId,
        issued_at: c.issuedAt,
        origin_tx_hash: originTxHash,
      };
      try {
        const response = await post(app, v2Body(fields, await signV2(fields)));
        expect(response.statusCode).to.equal(c.status);
        if (c.status === 401) {
          expect(response.json()).to.deep.equal({
            error: 'Invalid or missing CCS authentication',
          });
        }
        expect(fetch.callCount).to.equal(c.status === 200 ? 1 : 0);
      } finally {
        await app.close();
      }
    });
  }

  it('rejects a max age outside 10 to 120 integer seconds at construction', async () => {
    for (const authMaxAgeSeconds of [0, -1, 1, 9, 10.5, 121]) {
      let error: unknown;
      try {
        await server(undefined, undefined, { authMaxAgeSeconds });
      } catch (e: unknown) {
        error = e;
      }
      assert(error instanceof Error, `Expected ${authMaxAgeSeconds} to throw`);
      expect(error.message).to.equal(
        'CCS authentication max age must be an integer from 10 to 120',
      );
    }
  });

  it('rejects a signed message id that is not the decoded reveal message id', async () => {
    const fetch = stubFetch();
    const logs: Record<string, unknown>[] = [];
    const app = await server(undefined, undefined, { logs });
    const fields: V2Fields = {
      sender,
      data,
      message_id: messageId('0x1235'),
      issued_at: now,
      origin_tx_hash: originTxHash,
    };
    try {
      const response = await post(app, v2Body(fields, await signV2(fields)));
      expect(response.statusCode).to.equal(403);
      expect(response.json()).to.deep.equal({
        error: 'Reveal does not match the signed message id',
      });
      sinon.assert.notCalled(fetch);
      expect(
        logs.filter(
          (log) => log.msg === 'Reveal does not match the signed message id',
        ),
      ).to.have.length(1);
      expect(
        logs.find(
          (log) => log.msg === 'Reveal does not match the signed message id',
        ),
      ).to.include({
        relayer: wallet.address.toLowerCase(),
        signedMessageId: messageId('0x1235').toLowerCase(),
        revealMessageId: revealMessageId.toLowerCase(),
      });
    } finally {
      await app.close();
    }
  });

  interface TamperCase {
    name: string;
    sent: V2Fields;
    url?: string;
  }
  const otherData =
    CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
      'getCallsFromRevealMessage',
      ['0x1235'],
    );
  const tamperCases: TamperCase[] = [
    {
      name: 'url',
      sent: signed,
      url: origin + '/callCommitments/calldata',
    },
    {
      name: 'sender',
      sent: {
        sender: other.address,
        data,
        message_id: revealMessageId,
        issued_at: now,
        origin_tx_hash: originTxHash,
      },
    },
    {
      name: 'data',
      sent: {
        sender,
        data: otherData,
        message_id: revealMessageId,
        issued_at: now,
        origin_tx_hash: originTxHash,
      },
    },
    {
      name: 'message id',
      sent: {
        sender,
        data,
        message_id: messageId('0x1235'),
        issued_at: now,
        origin_tx_hash: originTxHash,
      },
    },
    {
      name: 'origin transaction hash',
      sent: {
        sender,
        data,
        message_id: revealMessageId,
        issued_at: now,
        origin_tx_hash: '0x' + '35'.repeat(32),
      },
    },
    {
      name: 'issued at',
      sent: {
        sender,
        data,
        message_id: revealMessageId,
        issued_at: now - 1,
        origin_tx_hash: originTxHash,
      },
    },
  ];
  for (const c of tamperCases) {
    it(`attributes a v2 request with a changed ${c.name} to another signer`, async () => {
      const fetch = stubFetch();
      const app = await server();
      try {
        const response = await post(
          app,
          v2Body(c.sent, await signV2(signed, wallet, c.url)),
        );
        expect(response.statusCode).to.equal(403);
        expect(response.json()).to.deep.equal({
          error: 'CCS signer not authorized',
        });
        sinon.assert.notCalled(fetch);
      } finally {
        await app.close();
      }
    });
  }

  it('rejects a v2 signature from a signer outside the whitelist', async () => {
    const fetch = stubFetch();
    const app = await server();
    try {
      const response = await post(
        app,
        v2Body(signed, await signV2(signed, other)),
      );
      expect(response.statusCode).to.equal(403);
      sinon.assert.notCalled(fetch);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing, null, or empty origin transaction hash over an empty-bytes signature', async () => {
    const fetch = stubFetch();
    const app = await server();
    const emptyHash: V2Fields = {
      sender,
      data,
      message_id: revealMessageId,
      issued_at: now,
      origin_tx_hash: '0x',
    };
    const signature = await signV2(emptyHash);
    try {
      for (const originTxHash of [undefined, null, '0x']) {
        const payload = v2Body(emptyHash, signature);
        payload.origin_tx_hash = originTxHash;
        const response = await post(app, payload);
        expect(response.statusCode).to.equal(401);
        expect(response.json()).to.deep.equal({
          error: 'Invalid or missing CCS authentication',
        });
      }
      sinon.assert.notCalled(fetch);
    } finally {
      await app.close();
    }
  });

  interface MalformedCase {
    name: string;
    payload: Record<string, unknown>;
  }
  const malformedCases: MalformedCase[] = [
    {
      name: 'a string issued_at',
      payload: { issued_at: String(now) },
    },
    { name: 'a fractional issued_at', payload: { issued_at: now + 0.5 } },
    { name: 'a negative issued_at', payload: { issued_at: -1 } },
    { name: 'a null issued_at', payload: { issued_at: null } },
    { name: 'no issued_at', payload: { issued_at: undefined } },
    { name: 'no message_id', payload: { message_id: undefined } },
    { name: 'a short message_id', payload: { message_id: '0x1234' } },
    {
      name: 'an odd-length origin_tx_hash',
      payload: { origin_tx_hash: '0x123' },
    },
    { name: 'a non-hex origin_tx_hash', payload: { origin_tx_hash: 'abc' } },
    { name: 'a numeric origin_tx_hash', payload: { origin_tx_hash: 1234 } },
    { name: 'an empty origin_tx_hash', payload: { origin_tx_hash: '' } },
    {
      name: 'an empty-bytes origin_tx_hash',
      payload: { origin_tx_hash: '0x' },
    },
    { name: 'a null origin_tx_hash', payload: { origin_tx_hash: null } },
    { name: 'no origin_tx_hash', payload: { origin_tx_hash: undefined } },
    { name: 'a boolean origin_tx_hash', payload: { origin_tx_hash: false } },
    { name: 'an object origin_tx_hash', payload: { origin_tx_hash: {} } },
  ];
  for (const c of malformedCases) {
    it(`answers 401 for a v2 body with ${c.name}`, async () => {
      const fetch = stubFetch();
      const app = await server();
      const signature = await signV2(signed);
      const payload: Record<string, unknown> = v2Body(signed, signature);
      for (const [key, value] of Object.entries(c.payload)) {
        payload[key] = value;
      }
      try {
        const response = await post(app, payload);
        expect(response.statusCode).to.equal(401);
        sinon.assert.notCalled(fetch);
      } finally {
        await app.close();
      }
    });
  }

  interface V1PostCase {
    name: string;
    messageId?: string;
  }
  const v1PostCases: V1PostCase[] = [
    { name: 'without a message_id' },
    { name: 'with the reveal message_id', messageId: revealMessageId },
  ];
  for (const c of v1PostCases) {
    it(`answers 401 for a v1 signature from an allowed signer ${c.name}`, async () => {
      const fetch = stubFetch();
      const app = await server();
      const signature = await wallet.signMessage(
        utils.arrayify(
          offchainLookupRequestMessageHash(sender, data, origin + postPath),
        ),
      );
      try {
        const response = await post(app, {
          sender,
          data,
          signature,
          message_id: c.messageId,
          origin_tx_hash: originTxHash,
        });
        expect(response.statusCode).to.equal(401);
        expect(response.json()).to.deep.equal({
          error: 'Invalid or missing CCS authentication',
        });
        sinon.assert.notCalled(fetch);
      } finally {
        await app.close();
      }
    });
  }

  interface FailureReasonCase {
    name: string;
    request: () => Promise<{
      method: 'GET' | 'POST';
      url: string;
      headers?: Record<string, string>;
      payload?: Record<string, unknown>;
    }>;
    reason: CcsAuthFailure;
  }
  const signedAt = async (issuedAt: number) => {
    const fields: V2Fields = {
      sender,
      data,
      message_id: revealMessageId,
      issued_at: issuedAt,
      origin_tx_hash: originTxHash,
    };
    return v2Body(fields, await signV2(fields));
  };
  const failureReasonCases: FailureReasonCase[] = [
    {
      name: 'a v1 POST body',
      request: async () => ({
        method: 'POST',
        url: postPath,
        payload: {
          sender,
          data,
          signature: await wallet.signMessage(
            utils.arrayify(
              offchainLookupRequestMessageHash(sender, data, origin + postPath),
            ),
          ),
          origin_tx_hash: originTxHash,
        },
      }),
      reason: CcsAuthFailure.MissingV2Fields,
    },
    {
      name: 'a POST body without credentials',
      request: async () => ({
        method: 'POST',
        url: postPath,
        payload: { data },
      }),
      reason: CcsAuthFailure.Malformed,
    },
    {
      name: 'a stale v2 signature',
      request: async () => ({
        method: 'POST',
        url: postPath,
        payload: await signedAt(now - 31),
      }),
      reason: CcsAuthFailure.Stale,
    },
    {
      name: 'a future-dated v2 signature',
      request: async () => ({
        method: 'POST',
        url: postPath,
        payload: await signedAt(now + 6),
      }),
      reason: CcsAuthFailure.FutureDated,
    },
    {
      name: 'an unrecoverable v2 signature',
      request: async () => ({
        method: 'POST',
        url: postPath,
        payload: v2Body(signed, '0x' + '00'.repeat(65)),
      }),
      reason: CcsAuthFailure.InvalidSignature,
    },
    {
      name: 'a GET signed for another sender',
      request: async () => ({
        method: 'GET',
        url: path,
        headers: await headers(wallet, undefined, undefined, other.address),
      }),
      reason: CcsAuthFailure.SenderMismatch,
    },
  ];
  for (const c of failureReasonCases) {
    it(`logs why ${c.name} failed authentication without returning it`, async () => {
      const fetch = stubFetch();
      const logs: Record<string, unknown>[] = [];
      const app = await server(undefined, undefined, { logs });
      try {
        const response = await app.inject(await c.request());
        expect(response.statusCode).to.equal(401);
        expect(response.json()).to.deep.equal({
          error: 'Invalid or missing CCS authentication',
        });
        expect(
          logs
            .filter((log) => log.msg === 'CCS authentication failed')
            .map((log) => log.reason),
        ).to.deep.equal([c.reason]);
        sinon.assert.notCalled(fetch);
      } finally {
        await app.close();
      }
    });
  }

  it('rejects a v1 signature sent with issued_at', async () => {
    const fetch = stubFetch();
    const app = await server();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      const response = await post(app, {
        sender,
        data,
        signature,
        message_id: revealMessageId,
        issued_at: now,
        origin_tx_hash: originTxHash,
      });
      expect(response.statusCode).to.equal(403);
      sinon.assert.notCalled(fetch);
    } finally {
      await app.close();
    }
  });
});

describe('CcsAuthMaxAgeSecondsSchema', () => {
  const EnvSchema = z.object({
    CCS_AUTH_MAX_AGE_SECONDS: CcsAuthMaxAgeSecondsSchema,
  });

  it('defaults an unset variable to 30 seconds', () => {
    expect(EnvSchema.parse({})).to.deep.equal({ CCS_AUTH_MAX_AGE_SECONDS: 30 });
  });

  interface Case {
    value: string | undefined;
    seconds: number;
  }
  const accepted: Case[] = [
    { value: undefined, seconds: 30 },
    { value: '30', seconds: 30 },
    { value: '120', seconds: 120 },
    { value: '10', seconds: 10 },
    { value: '010', seconds: 10 },
  ];
  for (const c of accepted) {
    it(`parses ${JSON.stringify(c.value)} as ${c.seconds}`, () => {
      expect(CcsAuthMaxAgeSecondsSchema.parse(c.value)).to.equal(c.seconds);
    });
  }

  for (const value of [
    '',
    ' 30 ',
    '1e3',
    '0x1e',
    '30.5',
    '0',
    '1',
    '9',
    '-5',
    '121',
    'abc',
    'Infinity',
    '9007199254740993',
  ]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(CcsAuthMaxAgeSecondsSchema.safeParse(value).success).to.equal(
        false,
      );
      let error: unknown;
      try {
        EnvSchema.parse({ CCS_AUTH_MAX_AGE_SECONDS: value });
      } catch (e: unknown) {
        error = e;
      }
      expect(error).to.be.instanceOf(z.ZodError);
    });
  }
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
    protocol = ProtocolType.Ethereum,
    sealevelRevealsEnabled = false,
  }: {
    trustRouters?: boolean;
    registeredWithDispatchedRouters?: boolean;
    commitOwner?: string;
    originV3Only?: boolean;
    destinationV3Only?: boolean;
    commitIsm?: string;
    protocol?: ProtocolType | null;
    sealevelRevealsEnabled?: boolean;
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
    const destinationCall = sinon
      .stub(destinationProvider, 'call')
      .callsFake(async (transaction) => {
        const [to, data] = await Promise.all([
          transaction.to,
          transaction.data,
        ]);
        assert(to && data, 'Expected a router call');
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
    if (protocol === null) multiProvider.getProtocol.throws('Unknown origin');
    else multiProvider.getProtocol.returns(protocol);
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
          [42161, '0x' + '34'.repeat(20)],
        ]),
      },
      { sealevelRevealsEnabled },
    );
    const data =
      CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
        'getCallsFromRevealMessage',
        [message],
      );
    const issuedAt = nowSeconds();
    /** A v2 reveal body that signs and sends `sentOriginTxHash`. */
    const revealPayload = async (
      sentOriginTxHash: unknown,
      signedOriginTxHash: string,
    ): Promise<Record<string, unknown>> => {
      const fields: V2Fields = {
        sender,
        data,
        message_id: messageId(message),
        issued_at: issuedAt,
        origin_tx_hash: signedOriginTxHash,
      };
      const body = v2Body(fields, await signV2(fields));
      body.origin_tx_hash = sentOriginTxHash;
      return body;
    };
    const payload = await revealPayload(originTxHash, originTxHash);
    return {
      app,
      payload,
      revealPayload,
      receipt,
      logs,
      icaApp,
      originCall,
      destinationCall,
      destinationRouter,
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
      sinon.assert.calledOnce(f.destinationCall);
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

  it('returns HTTP 401 for a null origin transaction hash over an empty-bytes signature', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: await f.revealPayload(null, '0x'),
      });
      expect(response.statusCode).to.equal(401);
      expect(response.json()).to.deep.equal({
        error: 'Invalid or missing CCS authentication',
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
    for (const {
      originTxHash,
      signedOriginTxHash,
      authenticated,
      validEvmHash,
    } of [
      {
        originTxHash: undefined,
        signedOriginTxHash: '0x',
        authenticated: false,
        validEvmHash: false,
      },
      {
        originTxHash: null,
        signedOriginTxHash: '0x',
        authenticated: false,
        validEvmHash: false,
      },
      {
        originTxHash: 1234,
        signedOriginTxHash: '0x1234',
        authenticated: false,
        validEvmHash: false,
      },
      {
        originTxHash: '',
        signedOriginTxHash: '0x',
        authenticated: false,
        validEvmHash: false,
      },
      {
        originTxHash: '0x',
        signedOriginTxHash: '0x',
        authenticated: false,
        validEvmHash: false,
      },
      {
        originTxHash: '0x1234',
        signedOriginTxHash: '0x1234',
        authenticated: true,
        validEvmHash: false,
      },
      {
        originTxHash: '0x' + 'ab'.repeat(32),
        signedOriginTxHash: '0x' + 'ab'.repeat(32),
        authenticated: true,
        validEvmHash: true,
      },
      {
        originTxHash: '0x' + 'ab'.repeat(64),
        signedOriginTxHash: '0x' + 'ab'.repeat(64),
        authenticated: true,
        validEvmHash: false,
      },
    ]) {
      it(`handles ${protocol ?? 'unknown'} origin with hash ${JSON.stringify(originTxHash)} when Sealevel reveals are ${sealevelRevealsEnabled ? 'enabled' : 'disabled'}`, async () => {
        const f = await fixture({ protocol, sealevelRevealsEnabled });
        const isEvm = protocol === ProtocolType.Ethereum;
        const isSealevel = protocol === ProtocolType.Sealevel;
        const status = !authenticated
          ? 401
          : isSealevel
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
            payload: await f.revealPayload(originTxHash, signedOriginTxHash),
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
                status === 401
                  ? 'Invalid or missing CCS authentication'
                  : status === 400
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
      sinon.assert.calledOnce(f.destinationCall);
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
      name: 'returns HTTP 500, not a denial, when a candidate ICA read is unavailable and none matches',
      options: {},
      setup: (f) => {
        f.icaApp.getAccount.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'Internal server error',
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
      name: 'returns HTTP 500 when the dispatched router pair cannot be read',
      options: {},
      setup: (f) => {
        f.destinationCall.rejects(unavailableRpc());
      },
      statusCode: 500,
      error: 'Internal server error',
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
          error: 'Internal server error',
        });
        sinon.assert.notCalled(f.destinationCall);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }
});
