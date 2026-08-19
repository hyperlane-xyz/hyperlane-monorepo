import { utils } from 'ethers';
import { expect } from 'chai';
import sinon from 'sinon';

import {
  PostCallsSchema,
  commitmentFromIcaCalls,
  encodeIcaCalls,
  isPostCallsIca,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import { addressToBytes32, formatMessage } from '@hyperlane-xyz/utils';

import { prisma } from '../../src/db.js';
import { CallCommitmentsService } from '../../src/services/CallCommitmentsService.js';
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
  const json = sinon.stub();
  const status = sinon.stub().returns({ json });
  const sendStatus = sinon.stub();
  const set = sinon.stub();
  return { status, json, sendStatus, set };
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
      },
    ]);
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
    const findUnique = sinon.stub().resolves(storedMetadata);
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

  it('authorizes an unpadded EVM relayer stored as bytes32', async () => {
    const service = createService();
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
    );

    expect(result).to.equal(
      mockIca + encodeIcaCalls(normalizeCalls(baseCalls), salt).slice(2),
    );
  });

  it('rejects an unlisted EVM relayer when the allowlist uses bytes32', async () => {
    const service = createService();
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
      baseRelayers[1],
      mockLogger(),
    );

    expect(JSON.parse(result)).to.deep.equal({
      error: `Relayer ${baseRelayers[1]} not authorized for this commitment`,
    });
  });
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
