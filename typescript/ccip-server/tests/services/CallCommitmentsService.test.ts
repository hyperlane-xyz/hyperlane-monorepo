import { ethers, providers, utils } from 'ethers';
import { expect } from 'chai';
import sinon from 'sinon';

import {
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type AccountConfig,
  InterchainAccount,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  PostCallsSchema,
  commitmentFromIcaCalls,
  encodeIcaCalls,
  isPostCallsIca,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import { BlockchainError } from '@hyperlane-xyz/sdk/providers/SmartProvider/SmartProvider';
import {
  addressToBytes32,
  formatMessage,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../../src/db.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import {
  CalldataLookupEnabledSchema,
  CallCommitmentsService,
  type IcaRouters,
  icaRoutersByDomain,
  mailboxesByDomain,
} from '../../src/services/CallCommitmentsService.js';
import { CommitmentAccessDeniedError } from '../../src/utils/errors.js';
import { RpcUnavailableError } from '../../src/utils/rpcErrors.js';
import { PrometheusMetrics } from '../../src/utils/prometheus.js';

function mockLogger() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
    setBindings: sinon.stub(),
    child: sinon.stub().returnsThis(),
  };
}

function mockRes() {
  const send = sinon.stub();
  const code = sinon.stub().returns({ send });
  const sendStatus = sinon.stub();
  const header = sinon.stub();
  return {
    code,
    header,
    json: send,
    send,
    sendStatus,
    set: header,
    status: code,
  };
}

function projectSelectedFields(
  record: Record<string, unknown>,
  select: object | null | undefined,
): Record<string, unknown> {
  const fields = new Set(
    Object.entries(select ?? {})
      .filter(([, selected]) => selected === true)
      .map(([field]) => field),
  );
  return Object.fromEntries(
    Object.entries(record).filter(([field]) => fields.has(field)),
  );
}

const validAddress = '0x' + 'ab'.repeat(20);
const salt = '0x' + '00'.repeat(32);
const mockIca = '0x' + 'ff'.repeat(20);

const baseCalls = [{ to: validAddress, data: '0x', value: '0' }];
const baseRelayers = ['0x' + 'cd'.repeat(20), '0x' + '12'.repeat(20)];

const icaPayload = {
  calls: baseCalls,
  relayers: baseRelayers,
  salt,
  originDomain: 1,
  destinationDomain: 2,
  owner: '0x' + 'aa'.repeat(20),
};

const legacyPayload = {
  calls: baseCalls,
  relayers: baseRelayers,
  salt,
  originDomain: 1,
  commitmentDispatchTx: '0x' + 'ef'.repeat(32),
};

const storedMetadata = {
  ica: mockIca,
  originDomain: icaPayload.originDomain,
  relayers: baseRelayers,
};

const abiData = utils.defaultAbiCoder.encode(
  ['tuple(bytes32 to, uint256 value, bytes data)[]'],
  [[{ to: addressToBytes32(validAddress), value: 0, data: '0x' }]],
);
const calldataSalt = '0x' + '56'.repeat(32);
const calldataCommitment = utils.keccak256(
  utils.concat([utils.arrayify(calldataSalt), utils.arrayify(abiData)]),
);
const destinationAccount = addressToBytes32(mockIca);
const calldataPayload = {
  commitment: calldataCommitment,
  originDomain: 1,
  data: abiData,
  salt: calldataSalt,
  relayers: [baseRelayers[0]],
  destinationAccount,
};

class TestPrismaUniqueConstraintError extends Error {
  readonly code = 'P2002';
}

afterEach(() => sinon.restore());

describe('PostCallsSchema union', () => {
  it('accepts new ICA shape', () => {
    const result = PostCallsSchema.safeParse(icaPayload);
    expect(result.success).to.be.true;
  });

  it('accepts legacy shape', () => {
    const result = PostCallsSchema.safeParse(legacyPayload);
    expect(result.success).to.be.true;
  });

  it('preserves explicit origin and destination routers in ICA requests', () => {
    const payload = {
      ...icaPayload,
      localRouter: '0x' + '31'.repeat(20),
      routerOverride: '0x' + '32'.repeat(20),
    };

    expect(PostCallsSchema.parse(payload)).to.deep.equal(payload);
  });

  for (const field of ['localRouter', 'routerOverride']) {
    it(`rejects malformed ${field} rather than selecting a default router`, () => {
      const result = PostCallsSchema.safeParse({
        ...icaPayload,
        [field]: 'invalid-router',
      });

      expect(result.success).to.be.false;
    });
  }

  it('rejects payload missing both discriminants', () => {
    const result = PostCallsSchema.safeParse({
      calls: baseCalls,
      relayers: baseRelayers,
      salt,
      originDomain: 1,
    });
    expect(result.success).to.be.false;
  });
});

describe('isPostCallsIca type guard', () => {
  it('returns true for ICA shape', () => {
    const parsed = PostCallsSchema.parse(icaPayload);
    expect(isPostCallsIca(parsed)).to.be.true;
  });

  it('returns false for legacy shape', () => {
    const parsed = PostCallsSchema.parse(legacyPayload);
    expect(isPostCallsIca(parsed)).to.be.false;
  });
});

describe('CallCommitmentsService.handleCommitment', () => {
  function createService(overrides: Record<string, any> = {}) {
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => mockLogger();
    service.config = { serviceName: 'callCommitments' };
    service.multiProvider = overrides.multiProvider ?? {};
    service.icaApp = overrides.icaApp ?? {};
    service.deriveIcaFromConfig =
      overrides.deriveIcaFromConfig ?? sinon.stub().resolves(mockIca);
    return service;
  }

  it('returns 400 when schema rejects invalid to address', async () => {
    const logger = mockLogger();
    const service = createService();
    service.addLoggerServiceContext = () => logger;

    const req = {
      body: {
        calls: [{ to: '', data: '0x', value: '0' }],
        relayers: baseRelayers,
        salt,
        commitmentDispatchTx: '0x' + 'ef'.repeat(32),
        originDomain: 1,
      },
      log: logger,
    };
    const res = mockRes();

    await service.handleCommitment(req, res);

    expect(res.status.calledWith(400)).to.be.true;
    expect(res.json.called).to.be.true;
  });

  it('routes ICA payload to deriveIcaFromConfig', async () => {
    const deriveIcaFromConfig = sinon.stub().resolves(mockIca);
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
      getProvider: sinon.stub(),
    };
    const service = createService({ deriveIcaFromConfig, multiProvider });
    service.upsertCommitmentInDB = sinon.stub().resolves(storedMetadata);

    const req = { body: icaPayload, log: mockLogger() };
    const res = mockRes();

    await service.handleCommitment(req, res);

    expect(deriveIcaFromConfig.calledOnce).to.be.true;
    expect(res.status.calledWith(200)).to.be.true;
    expect(
      res.json.calledWithMatch({
        commitment: commitmentFromIcaCalls(
          normalizeCalls(icaPayload.calls),
          salt,
        ),
        ica: storedMetadata.ica,
        originDomain: storedMetadata.originDomain,
      }),
    ).to.be.true;
  });

  it('retains V3 router selection through request parsing and persistence', async () => {
    const payload = {
      ...icaPayload,
      localRouter: '0x' + '31'.repeat(20),
      routerOverride: '0x' + '32'.repeat(20),
    };
    const v3Ica = '0x2254720417e8645d069821772790612149bf2c08';
    const deriveIcaFromConfig = sinon.stub().resolves(v3Ica);
    const service = createService({ deriveIcaFromConfig });
    const upsert = sinon.stub().resolves({ ...storedMetadata, ica: v3Ica });
    service.upsertCommitmentInDB = upsert;
    const res = mockRes();

    await service.handleCommitment({ body: payload, log: mockLogger() }, res);

    expect(deriveIcaFromConfig.firstCall.args[0]).to.deep.equal(payload);
    expect(upsert.firstCall.args[1]).to.deep.equal({ ...payload, ica: v3Ica });
    expect(res.status.calledWith(200)).to.be.true;
    expect(res.json.calledWithMatch({ ica: v3Ica })).to.be.true;
  });

  it('accepts an idempotent retry with reordered, differently-cased relayers and ICA', async () => {
    const icaApp = {
      getAccount: sinon.stub().resolves(mockIca),
    };
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
    };
    const service = createService({ icaApp, multiProvider });
    const existingMetadata = {
      ica: mockIca.toUpperCase(),
      originDomain: icaPayload.originDomain,
      relayers: [
        baseRelayers[1].toUpperCase(),
        baseRelayers[0].toUpperCase(),
        baseRelayers[0],
      ],
    };
    service.upsertCommitmentInDB = sinon.stub().resolves(existingMetadata);

    const res = mockRes();
    await service.handleCommitment(
      { body: icaPayload, log: mockLogger() },
      res,
    );

    expect(res.status.calledWith(200)).to.be.true;
    expect(
      res.json.calledWithMatch({
        ica: existingMetadata.ica,
        originDomain: existingMetadata.originDomain,
      }),
    ).to.be.true;
    expect(res.json.firstCall.args[0]).not.to.have.property('relayers');
  });

  it('accepts identical case-sensitive non-EVM relayers', async () => {
    const nonEvmRelayer = '11111111111111111111111111111111';
    const payload = { ...icaPayload, relayers: [nonEvmRelayer] };
    const icaApp = {
      getAccount: sinon.stub().resolves(mockIca),
    };
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
    };
    const service = createService({ icaApp, multiProvider });
    service.upsertCommitmentInDB = sinon.stub().resolves({
      ...storedMetadata,
      relayers: [nonEvmRelayer],
    });
    const res = mockRes();

    await service.handleCommitment({ body: payload, log: mockLogger() }, res);

    expect(res.status.calledWith(200)).to.be.true;
  });

  for (const [field, conflict] of [
    ['ICA', { ...storedMetadata, ica: '0x' + 'ee'.repeat(20) }],
    ['origin domain', { ...storedMetadata, originDomain: 3 }],
    ['relayers', { ...storedMetadata, relayers: [baseRelayers[0]] }],
  ] as const) {
    it(`returns 409 without overwriting when ${field} conflicts`, async () => {
      const icaApp = {
        getAccount: sinon.stub().resolves(mockIca),
      };
      const multiProvider = {
        getChainName: sinon.stub().returns('ethereum'),
      };
      const service = createService({ icaApp, multiProvider });
      const upsert = sinon.stub().resolves(conflict);
      service.upsertCommitmentInDB = upsert;

      const res = mockRes();
      await service.handleCommitment(
        { body: icaPayload, log: mockLogger() },
        res,
      );

      expect(upsert.calledOnce).to.be.true;
      expect(res.status.calledWith(409)).to.be.true;
      expect(
        res.json.calledWith({
          error: 'Commitment already exists with different metadata',
        }),
      ).to.be.true;
    });
  }

  it('returns 500 when the commitment upsert fails', async () => {
    sinon.stub(PrometheusMetrics, 'logUnhandledError');
    const icaApp = {
      getAccount: sinon.stub().resolves(mockIca),
    };
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
    };
    const service = createService({ icaApp, multiProvider });
    service.upsertCommitmentInDB = sinon
      .stub()
      .rejects(new Error('database unavailable'));

    const res = mockRes();
    await service.handleCommitment(
      { body: icaPayload, log: mockLogger() },
      res,
    );

    expect(res.status.calledWith(500)).to.be.true;
    expect(res.json.calledWith({ error: 'Internal server error' })).to.be.true;
  });

  it('does not write when ICA derivation fails', async () => {
    const deriveIcaFromConfig = sinon
      .stub()
      .rejects(new Error('destination RPC unavailable'));
    const service = createService({ deriveIcaFromConfig });
    service.upsertCommitmentInDB = sinon.stub();
    const res = mockRes();

    await service.handleCommitment(
      { body: icaPayload, log: mockLogger() },
      res,
    );

    expect(res.status.calledWith(400)).to.be.true;
    expect(service.upsertCommitmentInDB.called).to.be.false;
  });

  it('routes legacy payload to deriveIcaFromDispatchTx', async () => {
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
      getProvider: sinon.stub().returns({
        getTransactionReceipt: sinon.stub().resolves(null),
      }),
    };
    const service = createService({ multiProvider });

    const req = { body: legacyPayload, log: mockLogger() };
    const res = mockRes();

    await service.handleCommitment(req, res);

    // Should fail because receipt is null, returning 400
    expect(res.status.calledWith(400)).to.be.true;
    expect(multiProvider.getProvider.calledWith(legacyPayload.originDomain)).to
      .be.true;
  });

  it('uses one no-op upsert and returns its stored metadata', async () => {
    const service = createService();
    const record = {
      commitment: commitmentFromIcaCalls(
        normalizeCalls(icaPayload.calls),
        salt,
      ),
      calls: baseCalls,
      salt,
      ...storedMetadata,
      createdAt: new Date(),
    };
    const upsert = sinon.stub().resolves(record);
    sinon.stub(prisma, 'commitment').value({ upsert });

    const result = await service.upsertCommitmentInDB(
      record.commitment,
      { ...icaPayload, ica: mockIca },
      mockLogger(),
    );

    expect(upsert.calledOnce).to.be.true;
    expect(upsert.firstCall.args[0]).to.deep.include({
      where: { commitment: record.commitment },
      update: {},
    });
    expect(result).to.deep.equal(storedMetadata);
  });

  it('re-reads the winner when concurrent creation raises P2002', async () => {
    const service = createService();
    const commitment = commitmentFromIcaCalls(
      normalizeCalls(icaPayload.calls),
      salt,
    );
    const upsert = sinon.stub().callsFake(async () => {
      throw new TestPrismaUniqueConstraintError();
    });
    const findUnique = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ...storedMetadata,
      createdAt: new Date(),
    });
    sinon.stub(prisma, 'commitment').value({ upsert, findUnique });

    const result = await service.upsertCommitmentInDB(
      commitment,
      { ...icaPayload, ica: mockIca },
      mockLogger(),
    );

    expect(findUnique.calledOnceWithMatch({ where: { commitment } })).to.be
      .true;
    expect(result).to.deep.equal(storedMetadata);
  });

  it('rethrows P2002 when no winning row exists', async () => {
    const service = createService();
    const error = new TestPrismaUniqueConstraintError();
    const upsert = sinon.stub().callsFake(async () => {
      throw error;
    });
    const findUnique = sinon.stub().resolves(null);
    sinon.stub(prisma, 'commitment').value({ upsert, findUnique });

    let caught: unknown;
    try {
      await service.upsertCommitmentInDB(
        '0x' + '34'.repeat(32),
        { ...icaPayload, ica: mockIca },
        mockLogger(),
      );
    } catch (thrown: unknown) {
      caught = thrown;
    }

    expect(caught).to.equal(error);
  });

  it('rethrows non-race upsert errors', async () => {
    const service = createService();
    const error = new Error('database unavailable');
    const upsert = sinon.stub().rejects(error);
    const findUnique = sinon.stub();
    sinon.stub(prisma, 'commitment').value({ upsert, findUnique });

    let caught: unknown;
    try {
      await service.upsertCommitmentInDB(
        '0x' + '34'.repeat(32),
        { ...icaPayload, ica: mockIca },
        mockLogger(),
      );
    } catch (thrown: unknown) {
      caught = thrown;
    }

    expect(caught).to.equal(error);
    expect(findUnique.called).to.be.false;
  });
});

describe('CallCommitmentsService.deriveIcaFromConfig', () => {
  it('delegates the normalized chain config to the SDK', async () => {
    const getAccount = sinon.stub().resolves(mockIca);
    const service = Object.create(CallCommitmentsService.prototype);
    service.multiProvider = {
      getChainName: sinon
        .stub()
        .callsFake((domain: number) =>
          domain === icaPayload.originDomain ? 'ethereum' : 'optimism',
        ),
    };
    service.icaApp = { getAccount };
    const data = {
      ...icaPayload,
      ismOverride: '0x' + 'bb'.repeat(20),
      userSalt: '0x' + 'cc'.repeat(32),
    };

    expect(await service.deriveIcaFromConfig(data, mockLogger())).to.equal(
      mockIca,
    );
    expect(getAccount.calledOnce).to.be.true;
    expect(getAccount.firstCall.args).to.deep.equal([
      'optimism',
      {
        origin: 'ethereum',
        owner: data.owner,
        ismOverride: data.ismOverride,
        userSalt: data.userSalt,
        localRouter: undefined,
        routerOverride: undefined,
      },
    ]);
  });

  it('forwards both routers for V3 while retaining the default V2 app', async () => {
    const v3Ica = '0x2254720417e8645d069821772790612149bf2c08';
    const localRouter = '0x' + '31'.repeat(20);
    const routerOverride = '0x' + '32'.repeat(20);
    const getAccount = sinon.stub();
    getAccount.onFirstCall().resolves(mockIca);
    getAccount.onSecondCall().resolves(v3Ica);
    const service = Object.create(CallCommitmentsService.prototype);
    service.multiProvider = {
      getChainName: sinon
        .stub()
        .callsFake((domain: number) =>
          domain === icaPayload.originDomain ? 'base' : 'arbitrum',
        ),
    };
    service.icaApp = { getAccount };

    expect(
      await service.deriveIcaFromConfig(icaPayload, mockLogger()),
    ).to.equal(mockIca);
    expect(
      await service.deriveIcaFromConfig(
        { ...icaPayload, localRouter, routerOverride },
        mockLogger(),
      ),
    ).to.equal(v3Ica);

    expect(getAccount.firstCall.args).to.deep.equal([
      'arbitrum',
      {
        origin: 'base',
        owner: icaPayload.owner,
        ismOverride: undefined,
        userSalt: undefined,
        localRouter: undefined,
        routerOverride: undefined,
      },
    ]);
    expect(getAccount.secondCall.args).to.deep.equal([
      'arbitrum',
      {
        origin: 'base',
        owner: icaPayload.owner,
        ismOverride: undefined,
        userSalt: undefined,
        localRouter,
        routerOverride,
      },
    ]);
  });
});

describe('CallCommitmentsService.deriveIcaFromRevealMessage', () => {
  const originRouter = '0x' + '31'.repeat(20);
  const destinationRouter = '0x' + '32'.repeat(20);
  const originRouterV3 = '0x' + '51'.repeat(20);
  const destinationRouterV3 = '0x' + '52'.repeat(20);
  const mailbox = '0x' + '33'.repeat(20);
  const originTxHash = '0x' + '34'.repeat(32);
  const ism = '0x' + '35'.repeat(20);
  const userSalt = '0x' + '36'.repeat(32);
  const routerIca = '0x' + '99'.repeat(20);
  const commitment = commitmentFromIcaCalls(normalizeCalls(baseCalls), salt);
  const body = utils.solidityPack(
    ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    [
      1,
      addressToBytes32(icaPayload.owner),
      addressToBytes32(ism),
      userSalt,
      commitment,
    ],
  );
  const committedMessage = formatMessage(
    3,
    10,
    1,
    originRouter,
    2,
    destinationRouter,
    body,
  );
  const revealMessage = formatMessage(
    3,
    11,
    1,
    originRouter,
    2,
    destinationRouter,
    utils.solidityPack(['uint8', 'bytes32', 'bytes32'], [2, salt, commitment]),
  );

  function dispatchLog(message: string, logIndex: number, emitter = mailbox) {
    const event = Mailbox__factory.createInterface().encodeEventLog(
      Mailbox__factory.createInterface().getEvent('Dispatch'),
      [originRouter, 2, addressToBytes32(destinationRouter), message],
    );
    return { address: emitter, logIndex, ...event };
  }

  function createService(logs: ReturnType<typeof dispatchLog>[]) {
    const originProvider = new providers.JsonRpcProvider();
    const destinationProvider = new providers.JsonRpcProvider();
    const getTransactionReceipt = sinon.stub(
      originProvider,
      'getTransactionReceipt',
    );
    getTransactionReceipt.resolves({ logs });
    const originCall = sinon
      .stub(originProvider, 'call')
      .rejects(new Error('Unexpected origin call'));
    const destinationCall = sinon
      .stub(destinationProvider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['address'], [mockIca]));
    const connect = sinon.spy(InterchainAccountRouter__factory, 'connect');
    const service = Object.create(CallCommitmentsService.prototype);
    const getProvider = sinon.stub();
    getProvider.withArgs('base').returns(originProvider);
    getProvider.withArgs(2).returns(destinationProvider);
    const getChainName = sinon.stub();
    getChainName.withArgs(1).returns('base');
    getChainName.withArgs(2).returns('arbitrum');
    service.multiProvider = { getChainName, getProvider };
    service.originMailboxes = new Map([[1, mailbox]]);
    const getRouterAccount = sinon.stub().resolves(routerIca);
    service.icaApp = { getAccount: getRouterAccount };
    service.trustedIcaRouters = new Map([
      [
        1,
        {
          interchainAccountRouter: originRouter,
          interchainAccountRouterV3: originRouterV3,
        },
      ],
      [
        2,
        {
          interchainAccountRouter: destinationRouter,
          interchainAccountRouterV3: destinationRouterV3,
        },
      ],
    ]);
    return {
      service,
      destinationCall,
      getRouterAccount,
      getTransactionReceipt,
      connect,
      originCall,
    };
  }

  it('derives using both dispatched routers, owner, ISM, and user salt', async () => {
    const { service, destinationCall, connect } = createService([
      dispatchLog(committedMessage, 1),
      dispatchLog(revealMessage, 2),
    ]);

    expect(
      await service.deriveIcaFromRevealMessage(
        revealMessage,
        originTxHash,
        mockLogger(),
      ),
    ).to.deep.equal({
      ica: utils.getAddress(mockIca),
      routerVersionIcas: [routerIca, routerIca, routerIca, routerIca],
      unavailableCandidates: 0,
    });
    expect(connect.calledWith(destinationRouter)).to.be.true;
    const decoded =
      InterchainAccountRouter__factory.createInterface().decodeFunctionData(
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
        await destinationCall.firstCall.args[0].data,
      );
    expect(Array.from(decoded)).to.deep.equal([
      1,
      addressToBytes32(icaPayload.owner),
      addressToBytes32(originRouter),
      utils.getAddress(ism),
      userSalt,
    ]);
  });
  it('uses the nearest earlier commitment when the same hash is dispatched twice', async () => {
    const laterOwner = '0x' + '42'.repeat(20);
    const laterBody =
      '0x01' + addressToBytes32(laterOwner).slice(2) + body.slice(68);
    const laterCommit = formatMessage(
      3,
      10,
      1,
      originRouter,
      2,
      destinationRouter,
      laterBody,
    );
    const { service, destinationCall, originCall } = createService([
      dispatchLog(committedMessage, 0),
      dispatchLog(laterCommit, 1),
      dispatchLog(revealMessage, 2),
    ]);
    await service.deriveIcaFromRevealMessage(
      revealMessage,
      originTxHash,
      mockLogger(),
    );
    await service.deriveIcaFromRevealMessage(
      revealMessage,
      originTxHash,
      mockLogger(),
    );
    const decoded =
      InterchainAccountRouter__factory.createInterface().decodeFunctionData(
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
        await destinationCall.firstCall.args[0].data,
      );
    expect(decoded[1]).to.equal(addressToBytes32(laterOwner));
    sinon.assert.notCalled(originCall);
  });
  for (const layout of ['sequential', 'nested'] as const) {
    it(`pairs both ${layout} commit/reveal calls when their commitment hashes match`, async () => {
      const otherOwner = '0x' + '42'.repeat(20);
      const otherBody =
        '0x01' + addressToBytes32(otherOwner).slice(2) + body.slice(68);
      const otherCommit = formatMessage(
        3,
        layout === 'nested' ? 11 : 12,
        1,
        originRouter,
        2,
        destinationRouter,
        otherBody,
      );
      const otherReveal = formatMessage(
        3,
        layout === 'nested' ? 12 : 13,
        1,
        originRouter,
        2,
        destinationRouter,
        parseMessage(revealMessage).body,
      );
      const outerReveal =
        layout === 'nested'
          ? formatMessage(
              3,
              13,
              1,
              originRouter,
              2,
              destinationRouter,
              parseMessage(revealMessage).body,
            )
          : revealMessage;
      const orderedMessages =
        layout === 'nested'
          ? [committedMessage, otherCommit, otherReveal, outerReveal]
          : [committedMessage, outerReveal, otherCommit, otherReveal];
      const { service, destinationCall } = createService(
        orderedMessages.map((message, index) => dispatchLog(message, index)),
      );

      await service.deriveIcaFromRevealMessage(
        outerReveal,
        originTxHash,
        mockLogger(),
      );
      await service.deriveIcaFromRevealMessage(
        otherReveal,
        originTxHash,
        mockLogger(),
      );

      const iface = InterchainAccountRouter__factory.createInterface();
      const first = iface.decodeFunctionData(
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
        await destinationCall.firstCall.args[0].data,
      );
      const second = iface.decodeFunctionData(
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
        await destinationCall.secondCall.args[0].data,
      );
      expect(first[1]).to.equal(addressToBytes32(icaPayload.owner));
      expect(second[1]).to.equal(addressToBytes32(otherOwner));
    });
  }

  it('rejects a missing origin receipt before querying the destination', async () => {
    const { service, getTransactionReceipt, destinationCall } = createService(
      [],
    );
    getTransactionReceipt.resolves(null);
    const error = await service
      .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
      .catch((error: unknown) => error);
    expect(error)
      .to.be.instanceOf(Error)
      .with.property('message', `Transaction not found: ${originTxHash}`);
    sinon.assert.notCalled(destinationCall);
  });

  it('propagates origin RPC failures before querying the destination', async () => {
    const { service, getTransactionReceipt, destinationCall } = createService(
      [],
    );
    const unavailable = new Error('origin RPC unavailable');
    getTransactionReceipt.rejects(unavailable);
    const error = await service
      .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
      .catch((error: unknown) => error);
    expect(error).to.equal(unavailable);
    sinon.assert.notCalled(destinationCall);
  });

  for (const [name, logs] of [
    [
      'a forged mailbox emitter',
      [
        dispatchLog(committedMessage, 1, validAddress),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a forged reveal mailbox emitter',
      [
        dispatchLog(committedMessage, 1),
        dispatchLog(revealMessage, 2, validAddress),
      ],
    ],
    ['a receipt without the exact reveal', [dispatchLog(committedMessage, 1)]],
    [
      'a commitment dispatched after the reveal',
      [dispatchLog(committedMessage, 3), dispatchLog(revealMessage, 2)],
    ],
    [
      'a commitment already consumed by an earlier reveal',
      [
        dispatchLog(
          formatMessage(3, 8, 1, originRouter, 2, destinationRouter, body),
          0,
        ),
        dispatchLog(
          formatMessage(
            3,
            9,
            1,
            originRouter,
            2,
            destinationRouter,
            parseMessage(revealMessage).body,
          ),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a commitment from another sender',
      [
        dispatchLog(
          formatMessage(3, 10, 1, validAddress, 2, destinationRouter, body),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a commitment from another origin',
      [
        dispatchLog(
          formatMessage(3, 10, 3, originRouter, 2, destinationRouter, body),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a commitment for another destination',
      [
        dispatchLog(
          formatMessage(3, 10, 1, originRouter, 3, destinationRouter, body),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a commitment for a different router',
      [
        dispatchLog(
          formatMessage(3, 10, 1, originRouter, 2, validAddress, body),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
    [
      'a different commitment hash',
      [
        dispatchLog(
          formatMessage(
            3,
            10,
            1,
            originRouter,
            2,
            destinationRouter,
            body.slice(0, -64) + 'ab'.repeat(32),
          ),
          1,
        ),
        dispatchLog(revealMessage, 2),
      ],
    ],
  ] as const) {
    it(`rejects ${name} without querying a destination ICA`, async () => {
      const { service, destinationCall } = createService([...logs]);
      const error = await service
        .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(error).to.be.instanceOf(Error);
      expect(destinationCall.called).to.be.false;
    });
  }

  it('derives the ICA for each router version without an ISM override when the commit has none', async () => {
    const zeroIsmBody = body.slice(0, 68) + '00'.repeat(32) + body.slice(132);
    const zeroIsmCommit = formatMessage(
      3,
      10,
      1,
      originRouter,
      2,
      destinationRouter,
      zeroIsmBody,
    );
    const { service, getRouterAccount } = createService([
      dispatchLog(zeroIsmCommit, 1),
      dispatchLog(revealMessage, 2),
    ]);

    const { routerVersionIcas } = await service.deriveIcaFromRevealMessage(
      revealMessage,
      originTxHash,
      mockLogger(),
    );

    expect(routerVersionIcas).to.deep.equal([routerIca, routerIca]);
    const expectedConfig = (
      localRouter: string,
      routerOverride: string,
    ): AccountConfig => ({
      origin: 'base',
      owner: utils.getAddress(icaPayload.owner),
      userSalt,
      localRouter,
      routerOverride,
      ismOverride: undefined,
    });
    expect(getRouterAccount.getCalls().map((call) => call.args)).to.deep.equal([
      ['arbitrum', expectedConfig(originRouter, destinationRouter)],
      ['arbitrum', expectedConfig(originRouterV3, destinationRouterV3)],
    ]);
  });

  it('also derives each router version with the commit ISM when it has one', async () => {
    const { service, getRouterAccount } = createService([
      dispatchLog(committedMessage, 1),
      dispatchLog(revealMessage, 2),
    ]);

    await service.deriveIcaFromRevealMessage(
      revealMessage,
      originTxHash,
      mockLogger(),
    );

    expect(
      getRouterAccount
        .getCalls()
        .map((call) => [call.args[1].routerOverride, call.args[1].ismOverride]),
    ).to.deep.equal([
      [destinationRouter, undefined],
      [destinationRouter, addressToBytes32(ism)],
      [destinationRouterV3, undefined],
      [destinationRouterV3, addressToBytes32(ism)],
    ]);
  });

  interface VersionCase {
    name: string;
    trustedIcaRouters: ReadonlyMap<number, IcaRouters>;
    expectedPairs: Array<[localRouter: string, routerOverride: string]>;
  }

  const versionCases: VersionCase[] = [
    {
      name: 'only V2 on both chains',
      trustedIcaRouters: new Map([
        [1, { interchainAccountRouter: originRouter }],
        [2, { interchainAccountRouter: destinationRouter }],
      ]),
      expectedPairs: [
        [originRouter, destinationRouter],
        [originRouter, destinationRouter],
      ],
    },
    {
      name: 'V3 only on the origin chain',
      trustedIcaRouters: new Map([
        [
          1,
          {
            interchainAccountRouter: originRouter,
            interchainAccountRouterV3: originRouterV3,
          },
        ],
        [2, { interchainAccountRouter: destinationRouter }],
      ]),
      expectedPairs: [
        [originRouter, destinationRouter],
        [originRouter, destinationRouter],
      ],
    },
  ];

  for (const c of versionCases) {
    it(`only derives versions the registry has on both chains: ${c.name}`, async () => {
      const { service, getRouterAccount } = createService([
        dispatchLog(committedMessage, 1),
        dispatchLog(revealMessage, 2),
      ]);
      service.trustedIcaRouters = c.trustedIcaRouters;

      await service.deriveIcaFromRevealMessage(
        revealMessage,
        originTxHash,
        mockLogger(),
      );

      expect(
        getRouterAccount
          .getCalls()
          .map((call) => [
            call.args[1].localRouter,
            call.args[1].routerOverride,
          ]),
      ).to.deep.equal(c.expectedPairs);
    });
  }

  it('accepts a reveal dispatched through the V3 pair', async () => {
    const v3Commit = formatMessage(
      3,
      10,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      body,
    );
    const v3Reveal = formatMessage(
      3,
      11,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      parseMessage(revealMessage).body,
    );
    const { service, connect } = createService([
      dispatchLog(v3Commit, 1),
      dispatchLog(v3Reveal, 2),
    ]);

    const { ica } = await service.deriveIcaFromRevealMessage(
      v3Reveal,
      originTxHash,
      mockLogger(),
    );

    expect(ica).to.equal(utils.getAddress(mockIca));
    expect(connect.calledWith(destinationRouterV3)).to.be.true;
  });

  it('resolves a reveal from an origin with only a V3 router without reading the origin chain beyond the receipt', async () => {
    const v3Commit = formatMessage(
      3,
      10,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      body,
    );
    const v3Reveal = formatMessage(
      3,
      11,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      parseMessage(revealMessage).body,
    );
    const { service, getRouterAccount, getTransactionReceipt, originCall } =
      createService([dispatchLog(v3Commit, 1), dispatchLog(v3Reveal, 2)]);
    service.trustedIcaRouters = new Map([
      [1, { interchainAccountRouterV3: originRouterV3 }],
      [
        2,
        {
          interchainAccountRouter: destinationRouter,
          interchainAccountRouterV3: destinationRouterV3,
        },
      ],
    ]);

    const result = await service.deriveIcaFromRevealMessage(
      v3Reveal,
      originTxHash,
      mockLogger(),
    );

    expect(result).to.deep.equal({
      ica: utils.getAddress(mockIca),
      routerVersionIcas: [routerIca, routerIca],
      unavailableCandidates: 0,
    });
    expect(
      getRouterAccount
        .getCalls()
        .map((call) => [call.args[1].localRouter, call.args[1].routerOverride]),
    ).to.deep.equal([
      [originRouterV3, destinationRouterV3],
      [originRouterV3, destinationRouterV3],
    ]);
    sinon.assert.calledOnce(getTransactionReceipt);
    sinon.assert.notCalled(originCall);
  });

  /** An eth_call failure shaped as ethers and SmartProvider report it. */
  interface CandidateFailureCase {
    name: string;
    error: () => unknown;
    unavailable: boolean;
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
  const candidateFailureCases: CandidateFailureCase[] = [
    {
      name: 'a missing selector, e.g. a pre-salt router',
      error: missingSelector,
      unavailable: false,
    },
    {
      name: 'a revert the chain answered',
      error: () => new BlockchainError('execution reverted'),
      unavailable: false,
    },
    {
      name: 'a read no RPC provider answered',
      error: unavailableRpc,
      unavailable: true,
    },
  ];

  for (const c of candidateFailureCases) {
    it(`keeps going when a router version fails with ${c.name}, counting only unavailable reads`, async () => {
      const { service, getRouterAccount } = createService([
        dispatchLog(committedMessage, 1),
        dispatchLog(revealMessage, 2),
      ]);
      getRouterAccount.onCall(0).rejects(c.error());
      getRouterAccount.onCall(1).rejects(c.error());
      const log = mockLogger();

      const result = await service.deriveIcaFromRevealMessage(
        revealMessage,
        originTxHash,
        log,
      );

      expect(result).to.deep.equal({
        ica: utils.getAddress(mockIca),
        routerVersionIcas: [routerIca, routerIca],
        unavailableCandidates: c.unavailable ? 2 : 0,
      });
      expect(log.warn.callCount).to.equal(c.unavailable ? 2 : 0);
      expect(log.debug.callCount).to.equal(c.unavailable ? 0 : 2);
    });
  }

  it('derives no router version candidates for a destination without a V2 router', async () => {
    const v3Commit = formatMessage(
      3,
      10,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      body,
    );
    const v3Reveal = formatMessage(
      3,
      11,
      1,
      originRouterV3,
      2,
      destinationRouterV3,
      parseMessage(revealMessage).body,
    );
    const { service, destinationCall, getRouterAccount } = createService([
      dispatchLog(v3Commit, 1),
      dispatchLog(v3Reveal, 2),
    ]);
    service.trustedIcaRouters = new Map([
      [
        1,
        {
          interchainAccountRouter: originRouter,
          interchainAccountRouterV3: originRouterV3,
        },
      ],
      [2, { interchainAccountRouterV3: destinationRouterV3 }],
    ]);

    const result = await service.deriveIcaFromRevealMessage(
      v3Reveal,
      originTxHash,
      mockLogger(),
    );

    expect(result).to.deep.equal({
      ica: utils.getAddress(mockIca),
      routerVersionIcas: [],
      unavailableCandidates: 0,
    });
    sinon.assert.calledOnce(destinationCall);
    sinon.assert.notCalled(getRouterAccount);
  });

  for (const [name, logs, reason] of [
    [
      'a reveal that is not in the transaction',
      [dispatchLog(committedMessage, 1)],
      'Reveal message not found in origin transaction',
    ],
    [
      'a reveal without a commitment dispatched before it',
      [dispatchLog(revealMessage, 2)],
      'Matching commitment dispatch not found',
    ],
  ] as const) {
    it(`denies ${name}`, async () => {
      const { service, destinationCall, getRouterAccount } = createService([
        ...logs,
      ]);

      const error = await service
        .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
        .catch((error: unknown) => error);

      expect(error)
        .to.be.instanceOf(CommitmentAccessDeniedError)
        .with.property('message', reason);
      sinon.assert.notCalled(destinationCall);
      sinon.assert.notCalled(getRouterAccount);
    });
  }

  it('matches registry routers whose addresses contain letters, whatever their case', async () => {
    // The registry map is lowercased and `bytes32ToAddress` checksums, so the
    // comparison has to normalize: digit-only fixtures would hide a mismatch.
    const origin = '0x' + 'ab'.repeat(20);
    const destination = '0x' + 'cd'.repeat(20);
    const lettersCommit = formatMessage(3, 10, 1, origin, 2, destination, body);
    const lettersReveal = formatMessage(
      3,
      11,
      1,
      origin,
      2,
      destination,
      parseMessage(revealMessage).body,
    );
    const { service } = createService([
      dispatchLog(lettersCommit, 1),
      dispatchLog(lettersReveal, 2),
    ]);
    const domains = new Map([
      ['base', 1],
      ['arbitrum', 2],
    ]);
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.tryGetDomainId.callsFake((chain) =>
      typeof chain === 'string' ? (domains.get(chain) ?? null) : null,
    );
    service.trustedIcaRouters = icaRoutersByDomain(
      {
        base: { interchainAccountRouter: utils.getAddress(origin) },
        arbitrum: { interchainAccountRouter: utils.getAddress(destination) },
      },
      multiProvider,
    );

    const result = await service.deriveIcaFromRevealMessage(
      lettersReveal,
      originTxHash,
      mockLogger(),
    );

    expect(result.ica).to.equal(utils.getAddress(mockIca));
    expect(result.routerVersionIcas).to.have.length(2);
  });

  // Both routers must be ICA routers from the registry, on the chain the
  // reveal names for them.
  for (const [name, sender, recipient] of [
    ['an unknown origin router', '0x' + '77'.repeat(20), destinationRouter],
    ['an unknown destination router', originRouter, '0x' + '77'.repeat(20)],
    [
      'a router trusted only on the other chain',
      destinationRouter,
      originRouter,
    ],
  ] as const) {
    it(`refuses ${name} before reading anything`, async () => {
      const unlistedCommit = formatMessage(
        3,
        10,
        1,
        sender,
        2,
        recipient,
        body,
      );
      const unlistedReveal = formatMessage(
        3,
        11,
        1,
        sender,
        2,
        recipient,
        parseMessage(revealMessage).body,
      );
      const {
        service,
        getTransactionReceipt,
        destinationCall,
        getRouterAccount,
        connect,
      } = createService([
        dispatchLog(unlistedCommit, 1),
        dispatchLog(unlistedReveal, 2),
      ]);

      const error = await service
        .deriveIcaFromRevealMessage(unlistedReveal, originTxHash, mockLogger())
        .catch((error: unknown) => error);

      expect(error).to.be.instanceOf(CommitmentAccessDeniedError);
      sinon.assert.notCalled(getTransactionReceipt);
      sinon.assert.notCalled(destinationCall);
      sinon.assert.notCalled(getRouterAccount);
      expect(connect.called).to.be.false;
    });
  }

  it('denies reveals from a domain without registry ICA routers', async () => {
    const { service, getTransactionReceipt } = createService([
      dispatchLog(committedMessage, 1),
      dispatchLog(revealMessage, 2),
    ]);
    service.trustedIcaRouters = new Map([
      [2, { interchainAccountRouter: destinationRouter }],
    ]);

    const error = await service
      .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
      .catch((error: unknown) => error);

    expect(error).to.be.instanceOf(CommitmentAccessDeniedError);
    sinon.assert.notCalled(getTransactionReceipt);
  });

  function commitBody(owner: string, commitUserSalt: string, hash: string) {
    return utils.solidityPack(
      ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [1, addressToBytes32(owner), addressToBytes32(ism), commitUserSalt, hash],
    );
  }

  async function dispatchedPairArgs(destinationCall: sinon.SinonStub) {
    return InterchainAccountRouter__factory.createInterface().decodeFunctionData(
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)',
      await destinationCall.firstCall.args[0].data,
    );
  }

  it('derives every candidate from the owner and user salt of the paired commit when a transaction has several', async () => {
    const pairedOwner = '0x' + '42'.repeat(20);
    const earlierUserSalt = '0x' + '71'.repeat(32);
    const earlier = formatMessage(
      3,
      9,
      1,
      originRouter,
      2,
      destinationRouter,
      commitBody(icaPayload.owner, earlierUserSalt, commitment),
    );
    const paired = formatMessage(
      3,
      10,
      1,
      originRouter,
      2,
      destinationRouter,
      commitBody(pairedOwner, userSalt, commitment),
    );
    const { service, getRouterAccount, destinationCall } = createService([
      dispatchLog(earlier, 0),
      dispatchLog(paired, 1),
      dispatchLog(revealMessage, 2),
    ]);

    await service.deriveIcaFromRevealMessage(
      revealMessage,
      originTxHash,
      mockLogger(),
    );

    const decoded = await dispatchedPairArgs(destinationCall);
    expect(decoded[1]).to.equal(addressToBytes32(pairedOwner));
    expect(decoded[4]).to.equal(userSalt);
    expect(getRouterAccount.callCount).to.equal(4);
    for (const call of getRouterAccount.getCalls()) {
      expect(call.args[1].owner).to.equal(utils.getAddress(pairedOwner));
      expect(call.args[1].userSalt).to.equal(userSalt);
    }
  });

  it('pairs a reveal with its own commit when a nested commit and reveal for another commitment sit between them', async () => {
    const nestedOwner = '0x' + '42'.repeat(20);
    const nestedCommitment = '0x' + 'ab'.repeat(32);
    const nestedCommit = formatMessage(
      3,
      11,
      1,
      originRouter,
      2,
      destinationRouter,
      commitBody(nestedOwner, userSalt, nestedCommitment),
    );
    const nestedReveal = formatMessage(
      3,
      12,
      1,
      originRouter,
      2,
      destinationRouter,
      utils.solidityPack(
        ['uint8', 'bytes32', 'bytes32'],
        [2, salt, nestedCommitment],
      ),
    );
    const outerReveal = formatMessage(
      3,
      13,
      1,
      originRouter,
      2,
      destinationRouter,
      parseMessage(revealMessage).body,
    );
    const { service, destinationCall } = createService(
      [committedMessage, nestedCommit, nestedReveal, outerReveal].map(
        (dispatched, logIndex) => dispatchLog(dispatched, logIndex),
      ),
    );

    await service.deriveIcaFromRevealMessage(
      outerReveal,
      originTxHash,
      mockLogger(),
    );

    const decoded = await dispatchedPairArgs(destinationCall);
    expect(decoded[1]).to.equal(addressToBytes32(icaPayload.owner));
  });

  for (const c of candidateFailureCases) {
    it(`${c.unavailable ? 'fails without a denial' : 'denies the reveal'} when the dispatched router pair fails with ${c.name}`, async () => {
      const { service, destinationCall } = createService([
        dispatchLog(committedMessage, 1),
        dispatchLog(revealMessage, 2),
      ]);
      const failure = c.error();
      destinationCall.rejects(failure);

      const error = await service
        .deriveIcaFromRevealMessage(revealMessage, originTxHash, mockLogger())
        .catch((error: unknown) => error);

      if (c.unavailable) {
        expect(error)
          .to.be.instanceOf(RpcUnavailableError)
          .with.property('cause', failure);
      } else {
        expect(error)
          .to.be.instanceOf(CommitmentAccessDeniedError)
          .with.property(
            'message',
            'Dispatched routers do not derive an ICA for the reveal',
          );
      }
    });
  }
});

describe('icaRoutersByDomain', () => {
  const v2 = '0xAbCdEf0000000000000000000000000000000001';
  const v3 = '0xAbCdEf0000000000000000000000000000000003';

  function multiProviderWith(domains: Record<string, number>) {
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.tryGetDomainId.callsFake((chain) =>
      typeof chain === 'string' ? (domains[chain] ?? null) : null,
    );
    return multiProvider;
  }

  it('keys the registry routers of each version by domain, lowercased', () => {
    const routers = icaRoutersByDomain(
      {
        base: { interchainAccountRouter: v2, interchainAccountRouterV3: v3 },
      },
      multiProviderWith({ base: 8453 }),
    );

    expect(Array.from(routers.entries())).to.deep.equal([
      [
        8453,
        {
          interchainAccountRouter: v2.toLowerCase(),
          interchainAccountRouterV3: v3.toLowerCase(),
        },
      ],
    ]);
  });

  it('keeps chains that only have one version', () => {
    const routers = icaRoutersByDomain(
      {
        lisk: { interchainAccountRouter: v2 },
        arc: { interchainAccountRouterV3: v3 },
      },
      multiProviderWith({ lisk: 1135, arc: 5042 }),
    );

    expect(routers.get(1135)).to.deep.equal({
      interchainAccountRouter: v2.toLowerCase(),
    });
    expect(routers.get(5042)).to.deep.equal({
      interchainAccountRouterV3: v3.toLowerCase(),
    });
  });

  it('ignores other registry addresses and omits chains without ICA routers', () => {
    const routers = icaRoutersByDomain(
      {
        base: { mailbox: v2, interchainAccountIsm: v3 },
        lisk: { mailbox: v2, interchainAccountRouter: v2 },
      },
      multiProviderWith({ base: 8453, lisk: 1135 }),
    );

    expect(Array.from(routers.entries())).to.deep.equal([
      [1135, { interchainAccountRouter: v2.toLowerCase() }],
    ]);
  });

  it('skips chains the multi provider does not know', () => {
    const routers = icaRoutersByDomain(
      {
        base: { interchainAccountRouter: v2 },
        unknown: { interchainAccountRouter: v3 },
      },
      multiProviderWith({ base: 8453 }),
    );

    expect(Array.from(routers.keys())).to.deep.equal([8453]);
  });

  interface EmptyRouterCase {
    name: string;
    addresses: Record<string, string>;
    expected: Array<[number, IcaRouters]>;
  }

  const emptyRouterCases: EmptyRouterCase[] = [
    {
      name: 'an empty router string',
      addresses: { mailbox: v2, interchainAccountRouter: '' },
      expected: [],
    },
    {
      name: 'a zero router address',
      addresses: {
        mailbox: v2,
        interchainAccountRouter: '0x' + '00'.repeat(20),
      },
      expected: [],
    },
    {
      name: 'an empty router next to a deployed one',
      addresses: {
        mailbox: v2,
        interchainAccountRouter: '',
        interchainAccountRouterV3: v3,
      },
      expected: [[1135, { interchainAccountRouterV3: v3.toLowerCase() }]],
    },
  ];
  for (const c of emptyRouterCases) {
    it(`ignores ${c.name}`, () => {
      const routers = icaRoutersByDomain(
        { lisk: c.addresses },
        multiProviderWith({ lisk: 1135 }),
      );

      expect(Array.from(routers.entries())).to.deep.equal(c.expected);
    });
  }
});

describe('CalldataLookupEnabledSchema', () => {
  interface Case {
    value: string | undefined;
    enabled: boolean;
  }

  const accepted: Case[] = [
    { value: undefined, enabled: false },
    { value: 'false', enabled: false },
    { value: 'true', enabled: true },
  ];
  for (const c of accepted) {
    it(`parses ${String(c.value)} as ${c.enabled}`, () => {
      expect(CalldataLookupEnabledSchema.parse(c.value)).to.equal(c.enabled);
    });
  }

  for (const value of ['', 'TRUE', 'True', '1', '0', 'yes', 'on', ' true']) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(CalldataLookupEnabledSchema.safeParse(value).success).to.equal(
        false,
      );
    });
  }
});

describe('mailboxesByDomain', () => {
  const mailbox = '0xAbCdEf0000000000000000000000000000000004';

  function multiProviderWith(domains: Record<string, number>) {
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.tryGetDomainId.callsFake((chain) =>
      typeof chain === 'string' ? (domains[chain] ?? null) : null,
    );
    return multiProvider;
  }

  it('keys each registry mailbox by domain, lowercased', () => {
    const mailboxes = mailboxesByDomain(
      {
        base: { mailbox, interchainAccountRouterV3: mailbox },
        lisk: { mailbox },
      },
      multiProviderWith({ base: 8453, lisk: 1135 }),
    );

    expect(Array.from(mailboxes.entries())).to.deep.equal([
      [8453, mailbox.toLowerCase()],
      [1135, mailbox.toLowerCase()],
    ]);
  });

  it('skips chains the multi provider does not know', () => {
    const mailboxes = mailboxesByDomain(
      { base: { mailbox }, unknown: { mailbox } },
      multiProviderWith({ base: 8453 }),
    );

    expect(Array.from(mailboxes.keys())).to.deep.equal([8453]);
  });

  interface EmptyMailboxCase {
    name: string;
    addresses: Record<string, string>;
  }

  const emptyMailboxCases: EmptyMailboxCase[] = [
    {
      name: 'a missing mailbox',
      addresses: { interchainAccountRouter: mailbox },
    },
    { name: 'an empty mailbox string', addresses: { mailbox: '' } },
    {
      name: 'a zero mailbox address',
      addresses: { mailbox: '0x' + '00'.repeat(20) },
    },
  ];
  for (const c of emptyMailboxCases) {
    it(`ignores ${c.name}`, () => {
      const mailboxes = mailboxesByDomain(
        { lisk: c.addresses },
        multiProviderWith({ lisk: 1135 }),
      );

      expect(mailboxes.size).to.equal(0);
    });
  }
});

describe('CallCommitmentsService constructor', () => {
  const noRouters =
    'No ICA routers configured: callCommitments requires interchainAccountRouter or interchainAccountRouterV3 registry addresses';
  const mailbox = '0x' + '02'.repeat(20);

  /** Builds the service from registry addresses, as `create()` does. */
  function construct(addresses: Record<string, Record<string, string>>) {
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.tryGetDomainId.withArgs('base').returns(8453);
    multiProvider.tryGetDomainId.withArgs('lisk').returns(1135);
    return new CallCommitmentsService(
      {
        serviceName: 'callCommitments',
        baseUrl: 'https://ccs.example/callCommitments',
        multiProvider: sinon.createStubInstance(MultiProvider),
      },
      sinon.createStubInstance(InterchainAccount),
      [],
      icaRoutersByDomain(addresses, multiProvider),
      false,
      mailboxesByDomain(addresses, multiProvider),
    );
  }

  interface Case {
    name: string;
    addresses: Record<string, Record<string, string>>;
    error: string;
  }

  const rejected: Case[] = [
    { name: 'no routers', addresses: {}, error: noRouters },
    {
      name: 'a registry without ICA routers',
      addresses: { base: { mailbox } },
      error: noRouters,
    },
    {
      name: 'a registry whose ICA router addresses are empty',
      addresses: { base: { mailbox, interchainAccountRouter: '' } },
      error: noRouters,
    },
    {
      name: 'an ICA router chain without a mailbox',
      addresses: {
        base: { mailbox, interchainAccountRouter: '0x' + '01'.repeat(20) },
        lisk: { interchainAccountRouterV3: '0x' + '03'.repeat(20) },
      },
      error: 'Missing mailbox address for domain 1135',
    },
    {
      name: 'an ICA router chain with an empty mailbox',
      addresses: {
        lisk: {
          mailbox: '',
          interchainAccountRouterV3: '0x' + '03'.repeat(20),
        },
      },
      error: 'Missing mailbox address for domain 1135',
    },
  ];
  for (const c of rejected) {
    it(`refuses ${c.name}`, () => {
      expect(() => construct(c.addresses)).to.throw(c.error);
    });
  }

  it('accepts a registry with one ICA router and its mailbox', () => {
    expect(
      construct({
        base: { mailbox, interchainAccountRouterV3: '0x' + '01'.repeat(20) },
      }),
    ).to.be.instanceOf(CallCommitmentsService);
  });
});

describe('CallCommitmentsService.handleCheckCommitment', () => {
  function createService() {
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => mockLogger();
    service.config = { serviceName: 'callCommitments' };
    return service;
  }

  const commitment = '0x' + '34'.repeat(32);

  it('returns stored metadata and disables caching when present', async () => {
    const routingMetadata = {
      ica: storedMetadata.ica,
      originDomain: storedMetadata.originDomain,
    };
    const findUnique = sinon
      .stub()
      .callsFake(async ({ select }: Prisma.CommitmentFindUniqueArgs) =>
        projectSelectedFields(routingMetadata, select),
      );
    sinon.stub(prisma, 'commitment').value({ findUnique });
    const service = createService();
    const res = mockRes();

    await service.handleCheckCommitment(
      { params: { commitment }, log: mockLogger() },
      res,
    );

    expect(res.set.calledWith('Cache-Control', 'no-store')).to.be.true;
    expect(
      res.json.calledWith({
        exists: true,
        ica: storedMetadata.ica,
        originDomain: storedMetadata.originDomain,
      }),
    ).to.be.true;
    expect(res.json.firstCall.args[0]).not.to.have.property('relayers');
    expect(
      findUnique.calledOnceWithExactly({
        where: { commitment },
        select: { ica: true, originDomain: true },
      }),
    ).to.be.true;
  });

  it('returns exists false and disables caching when missing', async () => {
    const findUnique = sinon.stub().resolves(null);
    sinon.stub(prisma, 'commitment').value({ findUnique });
    const service = createService();
    const res = mockRes();

    await service.handleCheckCommitment(
      { params: { commitment }, log: mockLogger() },
      res,
    );

    expect(res.set.calledWith('Cache-Control', 'no-store')).to.be.true;
    expect(res.json.calledWith({ exists: false })).to.be.true;
  });

  it('returns 500 and disables caching when the database read fails', async () => {
    sinon.stub(PrometheusMetrics, 'logUnhandledError');
    const findUnique = sinon.stub().rejects(new Error('database unavailable'));
    sinon.stub(prisma, 'commitment').value({ findUnique });
    const service = createService();
    const res = mockRes();

    await service.handleCheckCommitment(
      { params: { commitment }, log: mockLogger() },
      res,
    );

    expect(res.set.calledWith('Cache-Control', 'no-store')).to.be.true;
    expect(res.status.calledWith(500)).to.be.true;
    expect(res.json.calledWith({ error: 'Internal server error' })).to.be.true;
  });
});

describe('CallCommitmentsService.handleFetchCommitment', () => {
  function createService() {
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => mockLogger();
    return service;
  }

  const commitment = commitmentFromIcaCalls(baseCalls, salt);
  const revealBody = utils.solidityPack(
    ['uint8', 'bytes32', 'bytes32'],
    [2, salt, commitment],
  );
  const message = formatMessage(
    3,
    0,
    1,
    validAddress,
    2,
    validAddress,
    revealBody,
  );

  const originTxHash = '0x' + '34'.repeat(32);
  const routerIca = '0x' + '99'.repeat(20);
  const otherIca = '0x2254720417e8645d069821772790612149bf2c08';

  /** A service whose reveal verification succeeds, unless overridden. */
  function createVerifyingService(overrides: Record<string, unknown> = {}) {
    const service = createService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: mockIca,
      originDomain: 1,
      relayers: baseRelayers,
    });
    service.deriveIcaFromRevealMessage = sinon.stub().resolves({
      ica: mockIca,
      routerVersionIcas: [],
      unavailableCandidates: 0,
    });
    return Object.assign(service, overrides);
  }

  const servedCalls = (ica: string) =>
    ica + encodeIcaCalls(normalizeCalls(baseCalls), salt).slice(2);

  it('matches a stored ICA regardless of address case', async () => {
    const service = createVerifyingService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: utils.getAddress(mockIca),
      originDomain: 1,
      relayers: baseRelayers,
    });

    const result = await service.handleFetchCommitment(
      message,
      baseRelayers[0],
      mockLogger(),
      originTxHash,
    );

    expect(result).to.equal(servedCalls(mockIca));
  });

  it('authorizes an unpadded EVM relayer stored as bytes32', async () => {
    const service = createVerifyingService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: mockIca,
      originDomain: 1,
      relayers: [addressToBytes32(baseRelayers[0])],
    });

    const result = await service.handleFetchCommitment(
      message,
      baseRelayers[0],
      mockLogger(),
      originTxHash,
    );

    expect(result).to.equal(servedCalls(mockIca));
  });

  it('rejects an unlisted EVM relayer when the allowlist uses bytes32', async () => {
    const service = createVerifyingService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: mockIca,
      originDomain: 1,
      relayers: [addressToBytes32(baseRelayers[0])],
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[1],
        mockLogger(),
        originTxHash,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(error)
      .to.be.instanceOf(Error)
      .with.property('message', 'Signer not authorized for this commitment');
  });

  it('serves the calls when the dispatched ICA is the stored one', async () => {
    const service = createVerifyingService();
    const updateMany = sinon.stub().resolves({ count: 1 });
    sinon.stub(prisma, 'commitment').value({ updateMany });

    const result = await service.handleFetchCommitment(
      message,
      baseRelayers[0],
      mockLogger(),
      originTxHash,
    );

    sinon.assert.calledOnceWithExactly(
      service.deriveIcaFromRevealMessage,
      message,
      originTxHash,
      sinon.match.object,
    );
    expect(result).to.equal(servedCalls(mockIca));
    sinon.assert.notCalled(updateMany);
  });

  for (const [name, routerVersionIcas] of [
    ['came from another router version', [mockIca]],
    ['matches any router version or ISM candidate', [routerIca, mockIca]],
  ] as const) {
    it(`serves the dispatched ICA when the stored one ${name}`, async () => {
      // V3 routes registered without router overrides store the V2-derived
      // ICA; the reveal still has to execute on the V3 account.
      const service = createVerifyingService({
        deriveIcaFromRevealMessage: sinon.stub().resolves({
          ica: otherIca,
          routerVersionIcas,
          unavailableCandidates: 0,
        }),
      });

      const result = await service.handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      );

      expect(result).to.equal(servedCalls(otherIca));
    });
  }

  it('denies the reveal when no candidate ICA equals the stored one', async () => {
    const service = createVerifyingService({
      deriveIcaFromRevealMessage: sinon.stub().resolves({
        ica: otherIca,
        routerVersionIcas: [routerIca],
        unavailableCandidates: 0,
      }),
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(error)
      .to.be.instanceOf(CommitmentAccessDeniedError)
      .with.property('message', 'Reveal does not belong to this commitment');
  });

  it('retries instead of denying when a candidate that could have matched failed to derive', async () => {
    // e.g. the destination RPC timed out on the V2 candidate while the V3
    // dispatch differs from the stored (V2) ICA: not a denial.
    const service = createVerifyingService({
      deriveIcaFromRevealMessage: sinon.stub().resolves({
        ica: otherIca,
        routerVersionIcas: [routerIca],
        unavailableCandidates: 1,
      }),
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(error)
      .to.be.instanceOf(Error)
      .with.property(
        'message',
        'Could not derive every ICA candidate for the reveal',
      );
    expect(error).not.to.be.instanceOf(CommitmentAccessDeniedError);
  });

  it('still serves when a candidate failed to derive but another matched', async () => {
    const service = createVerifyingService({
      deriveIcaFromRevealMessage: sinon.stub().resolves({
        ica: otherIca,
        routerVersionIcas: [mockIca],
        unavailableCandidates: 1,
      }),
    });

    const result = await service.handleFetchCommitment(
      message,
      baseRelayers[0],
      mockLogger(),
      originTxHash,
    );

    expect(result).to.equal(servedCalls(otherIca));
  });

  it('requires an origin transaction hash', async () => {
    const service = createVerifyingService();

    for (const hint of [undefined, '']) {
      const error = await service
        .handleFetchCommitment(message, baseRelayers[0], mockLogger(), hint)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(error)
        .to.be.instanceOf(Error)
        .with.property(
          'message',
          'Missing origin transaction hash for reveal message',
        );
      expect(error).not.to.be.instanceOf(CommitmentAccessDeniedError);
    }
    sinon.assert.notCalled(service.deriveIcaFromRevealMessage);
  });

  it('propagates a denied reveal', async () => {
    const service = createVerifyingService({
      deriveIcaFromRevealMessage: sinon
        .stub()
        .rejects(new CommitmentAccessDeniedError('not this commitment')),
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      )
      .catch((error: unknown) => error);

    expect(error)
      .to.be.instanceOf(CommitmentAccessDeniedError)
      .with.property('message', 'not this commitment');
  });

  it('does not serve when the dispatch cannot be verified', async () => {
    const unavailable = new Error('origin RPC unavailable');
    const service = createVerifyingService({
      deriveIcaFromRevealMessage: sinon.stub().rejects(unavailable),
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      )
      .catch((error: unknown) => error);

    expect(error).to.equal(unavailable);
  });

  it('denies unauthorized relayers before reading any chain state', async () => {
    const service = createVerifyingService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: mockIca,
      originDomain: 1,
      relayers: [baseRelayers[0]],
    });

    const error = await service
      .handleFetchCommitment(
        message,
        baseRelayers[1],
        mockLogger(),
        originTxHash,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(error)
      .to.be.instanceOf(Error)
      .with.property('message', 'Signer not authorized for this commitment');
    sinon.assert.notCalled(service.deriveIcaFromRevealMessage);
  });

  it('denies an origin mismatch before reading any chain state', async () => {
    const service = createVerifyingService();
    service.fetchCommitmentRecord = sinon.stub().resolves({
      commitment,
      calls: baseCalls,
      salt,
      ica: mockIca,
      originDomain: 3,
      relayers: baseRelayers,
    });

    const result = await service
      .handleFetchCommitment(
        message,
        baseRelayers[0],
        mockLogger(),
        originTxHash,
      )
      .catch((error: unknown) => error);

    expect(result)
      .to.be.instanceOf(CommitmentAccessDeniedError)
      .with.property(
        'message',
        'Reveal origin does not match stored commitment',
      );
    sinon.assert.notCalled(service.deriveIcaFromRevealMessage);
  });

  interface LogFieldCase {
    name: string;
    overrides: Record<string, unknown>;
    level: 'info' | 'warn' | 'error';
  }

  const logFieldCases: LogFieldCase[] = [
    { name: 'served calls', overrides: {}, level: 'info' },
    {
      name: 'a denial',
      overrides: {
        deriveIcaFromRevealMessage: sinon
          .stub()
          .rejects(new CommitmentAccessDeniedError('not this commitment')),
      },
      level: 'warn',
    },
    {
      name: 'an error',
      overrides: {
        deriveIcaFromRevealMessage: sinon
          .stub()
          .rejects(new Error('origin RPC unavailable')),
      },
      level: 'error',
    },
  ];

  for (const c of logFieldCases) {
    it(`logs the reveal as revealMessage, never as the log message key, for ${c.name}`, async () => {
      const service = createVerifyingService(c.overrides);
      const logger = mockLogger();
      service.addLoggerServiceContext = () => logger;

      await service
        .handleFetchCommitment(message, baseRelayers[0], logger, originTxHash)
        .catch(() => undefined);

      const fields = [logger.info, logger.warn, logger.error].flatMap((stub) =>
        stub.getCalls().map((call) => call.args[0]),
      );
      for (const field of fields) {
        expect(field).not.to.have.property('message');
      }
      expect(
        logger[c.level]
          .getCalls()
          .some((call) => call.args[0]?.revealMessage === message),
      ).to.equal(true);
    });
  }
});

describe('CallCommitmentsService.handleCalldataPost', () => {
  function createService() {
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => mockLogger();
    service.config = { serviceName: 'callCommitments' };
    return service;
  }

  function storedCalldata(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      originDomain: calldataPayload.originDomain,
      data: calldataPayload.data,
      salt: calldataPayload.salt,
      relayers: calldataPayload.relayers,
      destinationAccount: calldataPayload.destinationAccount,
      revealAccounts: null,
      ...overrides,
    };
  }

  function storedCommitment(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ica: mockIca,
      originDomain: calldataPayload.originDomain,
      relayers: calldataPayload.relayers,
      calls: [{ to: addressToBytes32(validAddress), data: '0x', value: '0' }],
      salt: calldataPayload.salt,
      ...overrides,
    };
  }

  it('atomically stores EVM calldata and its legacy commitment', async () => {
    const calldataUpsert = sinon.stub().resolves(storedCalldata());
    const commitmentUpsert = sinon.stub().resolves(storedCommitment());
    const transaction = sinon.stub().callsFake(async (write) =>
      write({
        calldata: { upsert: calldataUpsert },
        commitment: { upsert: commitmentUpsert },
      }),
    );
    sinon.stub(prisma, '$transaction').value(transaction);
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: calldataPayload, log: mockLogger() },
      res,
    );

    expect(transaction.calledOnce).to.be.true;
    expect(calldataUpsert.calledOnce).to.be.true;
    expect(commitmentUpsert.calledOnce).to.be.true;
    expect(calldataUpsert.firstCall.args[0]).to.deep.include({
      update: { commitment: calldataCommitment },
    });
    expect(commitmentUpsert.firstCall.args[0]).to.deep.include({
      update: { commitment: calldataCommitment },
    });
    expect(res.status.calledWith(200)).to.be.true;
    expect(res.json.calledWith({ commitment: calldataCommitment })).to.be.true;
  });

  it('accepts an identical EVM retry with canonicalized relayers', async () => {
    const calldataUpsert = sinon
      .stub()
      .resolves(
        storedCalldata({ relayers: [addressToBytes32(baseRelayers[0])] }),
      );
    const commitmentUpsert = sinon
      .stub()
      .resolves(
        storedCommitment({ relayers: [addressToBytes32(baseRelayers[0])] }),
      );
    const transaction = sinon.stub().callsFake(async (write) =>
      write({
        calldata: { upsert: calldataUpsert },
        commitment: { upsert: commitmentUpsert },
      }),
    );
    sinon.stub(prisma, '$transaction').value(transaction);
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      {
        body: {
          ...calldataPayload,
          commitment: '0x' + calldataPayload.commitment.slice(2).toUpperCase(),
        },
        log: mockLogger(),
      },
      res,
    );

    expect(res.status.calledWith(200)).to.be.true;
    expect(calldataUpsert.firstCall.args[0]).to.deep.include({
      where: { commitment: calldataCommitment },
    });
  });

  it('accepts concurrent identical EVM retries', async () => {
    const calldataUpsert = sinon.stub().resolves(storedCalldata());
    const commitmentUpsert = sinon.stub().resolves(storedCommitment());
    const transaction = sinon.stub().callsFake(async (write) =>
      write({
        calldata: { upsert: calldataUpsert },
        commitment: { upsert: commitmentUpsert },
      }),
    );
    sinon.stub(prisma, '$transaction').value(transaction);
    const service = createService();
    const responses = [mockRes(), mockRes()];

    await Promise.all(
      responses.map((res) =>
        service.handleCalldataPost(
          { body: calldataPayload, log: mockLogger() },
          res,
        ),
      ),
    );

    expect(transaction.callCount).to.equal(2);
    expect(calldataUpsert.callCount).to.equal(2);
    expect(commitmentUpsert.callCount).to.equal(2);
    expect(responses.every((res) => res.status.calledWith(200))).to.be.true;
  });

  it('rolls back both EVM writes when the legacy commitment conflicts', async () => {
    let rolledBack = false;
    const calldataUpsert = sinon.stub().resolves(storedCalldata());
    const commitmentUpsert = sinon
      .stub()
      .resolves(storedCommitment({ originDomain: 2 }));
    const transaction = sinon.stub().callsFake(async (write) => {
      try {
        return await write({
          calldata: { upsert: calldataUpsert },
          commitment: { upsert: commitmentUpsert },
        });
      } catch (error: unknown) {
        rolledBack = true;
        throw error;
      }
    });
    sinon.stub(prisma, '$transaction').value(transaction);
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: calldataPayload, log: mockLogger() },
      res,
    );

    expect(rolledBack).to.be.true;
    expect(res.status.calledWith(409)).to.be.true;
  });

  it('rejects conflicting stored calldata without writing legacy state', async () => {
    const calldataUpsert = sinon
      .stub()
      .resolves(
        storedCalldata({ destinationAccount: addressToBytes32(validAddress) }),
      );
    const commitmentUpsert = sinon.stub();
    const transaction = sinon.stub().callsFake(async (write) =>
      write({
        calldata: { upsert: calldataUpsert },
        commitment: { upsert: commitmentUpsert },
      }),
    );
    sinon.stub(prisma, '$transaction').value(transaction);
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: calldataPayload, log: mockLogger() },
      res,
    );

    expect(commitmentUpsert.called).to.be.false;
    expect(res.status.calledWith(409)).to.be.true;
  });

  it('stores non-ABI calldata without opening a transaction', async () => {
    const solanaData = '0x01';
    const solanaPayload = {
      ...calldataPayload,
      data: solanaData,
      relayers: ['0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5'],
      commitment: utils.keccak256(
        utils.concat([
          utils.arrayify(calldataPayload.salt),
          utils.arrayify(solanaData),
        ]),
      ),
    };
    const calldataUpsert = sinon.stub().resolves(
      storedCalldata({
        data: solanaData,
        relayers: solanaPayload.relayers,
        destinationAccount: solanaPayload.destinationAccount,
      }),
    );
    sinon.stub(prisma, 'calldata').value({ upsert: calldataUpsert });
    const transaction = sinon.stub(prisma, '$transaction');
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: solanaPayload, log: mockLogger() },
      res,
    );

    expect(calldataUpsert.firstCall.args[0].create.relayers).to.deep.equal(
      solanaPayload.relayers,
    );
    expect(transaction.called).to.be.false;
    expect(res.status.calledWith(200)).to.be.true;
  });

  it('rejects conflicting non-ABI calldata without opening a transaction', async () => {
    const solanaData = '0x01';
    const solanaPayload = {
      ...calldataPayload,
      data: solanaData,
      commitment: utils.keccak256(
        utils.concat([
          utils.arrayify(calldataPayload.salt),
          utils.arrayify(solanaData),
        ]),
      ),
    };
    const calldataUpsert = sinon.stub().resolves(
      storedCalldata({
        data: solanaData,
        originDomain: 2,
      }),
    );
    sinon.stub(prisma, 'calldata').value({ upsert: calldataUpsert });
    const transaction = sinon.stub(prisma, '$transaction');
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: solanaPayload, log: mockLogger() },
      res,
    );

    expect(transaction.called).to.be.false;
    expect(res.status.calledWith(409)).to.be.true;
  });

  it('returns 500 when the atomic EVM write fails', async () => {
    sinon.stub(PrometheusMetrics, 'logUnhandledError');
    sinon
      .stub(prisma, '$transaction')
      .rejects(new Error('database unavailable'));
    const service = createService();
    const res = mockRes();

    await service.handleCalldataPost(
      { body: calldataPayload, log: mockLogger() },
      res,
    );

    expect(res.status.calledWith(500)).to.be.true;
    expect(res.json.calledWith({ error: 'Internal server error' })).to.be.true;
  });
});

describe('CallCommitmentsService read projections', () => {
  function createService() {
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => mockLogger();
    service.auth = { signer: () => baseRelayers[0] };
    return service;
  }

  it('retrieves all reveal fields without fetching creation metadata', async () => {
    const commitment = '0x' + '34'.repeat(32);
    const record = {
      commitment,
      ...storedMetadata,
      calls: baseCalls,
      salt,
    };
    const findUnique = sinon
      .stub()
      .callsFake(async ({ select }: Prisma.CommitmentFindUniqueArgs) =>
        projectSelectedFields(record, select),
      );
    sinon.stub(prisma, 'commitment').value({ findUnique });

    expect(
      await createService().fetchCommitmentRecord(commitment, mockLogger()),
    ).to.deep.equal(record);
    expect(
      findUnique.calledOnceWithExactly({
        where: { commitment },
        select: {
          commitment: true,
          ica: true,
          originDomain: true,
          relayers: true,
          calls: true,
          salt: true,
        },
      }),
    ).to.be.true;
  });

  it('retrieves calldata response and authorization fields only', async () => {
    const record = { ...calldataPayload, revealAccounts: null };
    const findUnique = sinon
      .stub()
      .callsFake(async ({ select }: Prisma.CalldataFindUniqueArgs) =>
        projectSelectedFields(record, select),
      );
    sinon.stub(prisma, 'calldata').value({ findUnique });
    const res = mockRes();

    await createService().handleCalldataGet(
      { params: { commitment: record.commitment }, log: mockLogger() },
      res,
    );

    expect(
      findUnique.calledOnceWithExactly({
        where: { commitment: record.commitment },
        select: {
          originDomain: true,
          data: true,
          salt: true,
          relayers: true,
          destinationAccount: true,
          revealAccounts: true,
        },
      }),
    ).to.be.true;
    expect(
      res.send.calledOnceWithExactly({
        originDomain: record.originDomain,
        data: record.data,
        salt: record.salt,
        destinationAccount: record.destinationAccount,
      }),
    ).to.be.true;
  });
});

describe('normalizeCalls', () => {
  it('throws on malformed address that bypasses schema', () => {
    expect(() => {
      normalizeCalls([{ to: 'not-an-address', data: '0x', value: '0' }]);
    }).to.throw('address bytes must not be empty');
  });

  it('commitmentFromIcaCalls works with valid normalized calls', () => {
    const result = commitmentFromIcaCalls(
      normalizeCalls([{ to: validAddress, data: '0x', value: '0' }]),
      salt,
    );
    expect(result).to.not.be.undefined;
    expect(result.startsWith('0x')).to.be.true;
  });
});
