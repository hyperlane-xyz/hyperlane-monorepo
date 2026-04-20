import { expect } from 'chai';
import sinon from 'sinon';

import {
  PostCallsSchema,
  commitmentFromIcaCalls,
  isPostCallsIca,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';

import { CallCommitmentsService } from '../../src/services/CallCommitmentsService.js';

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
  return { status, json, sendStatus };
}

const validAddress = '0x' + 'ab'.repeat(20);
const salt = '0x' + '00'.repeat(32);

const baseCalls = [{ to: validAddress, data: '0x', value: '0' }];
const baseRelayers = ['0x' + 'cd'.repeat(20)];

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
    service.multiProvider = overrides.multiProvider ?? {};
    service.icaApp = overrides.icaApp ?? {};
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
    const mockIca = '0x' + 'ff'.repeat(20);
    const icaApp = {
      getAccount: sinon.stub().resolves(mockIca),
    };
    const multiProvider = {
      getChainName: sinon.stub().returns('ethereum'),
      getProvider: sinon.stub(),
    };
    const service = createService({ icaApp, multiProvider });
    service.upsertCommitmentInDB = sinon.stub().resolves();

    const req = { body: icaPayload, log: mockLogger() };
    const res = mockRes();

    await service.handleCommitment(req, res);

    expect(icaApp.getAccount.called).to.be.true;
    expect(res.sendStatus.calledWith(200)).to.be.true;
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
