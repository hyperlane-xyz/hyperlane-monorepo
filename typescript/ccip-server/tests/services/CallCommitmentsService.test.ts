import { describe, expect, jest, test } from '@jest/globals';

import {
  PostCallsSchema,
  commitmentFromIcaCalls,
  isPostCallsIca,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';

import { CallCommitmentsService } from '../../src/services/CallCommitmentsService';

function mockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setBindings: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

function mockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const sendStatus = jest.fn();
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
  test('accepts new ICA shape', () => {
    const result = PostCallsSchema.safeParse(icaPayload);
    expect(result.success).toBe(true);
  });

  test('accepts legacy shape', () => {
    const result = PostCallsSchema.safeParse(legacyPayload);
    expect(result.success).toBe(true);
  });

  test('rejects payload missing both discriminants', () => {
    const result = PostCallsSchema.safeParse({
      calls: baseCalls,
      relayers: baseRelayers,
      salt,
      originDomain: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('isPostCallsIca type guard', () => {
  test('returns true for ICA shape', () => {
    const parsed = PostCallsSchema.parse(icaPayload);
    expect(isPostCallsIca(parsed)).toBe(true);
  });

  test('returns false for legacy shape', () => {
    const parsed = PostCallsSchema.parse(legacyPayload);
    expect(isPostCallsIca(parsed)).toBe(false);
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

  test('returns 400 when schema rejects invalid to address', async () => {
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

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
  });

  test('routes ICA payload to deriveIcaFromConfig', async () => {
    const mockIca = '0x' + 'ff'.repeat(20);
    const icaApp = {
      getAccount: jest.fn<() => Promise<string>>().mockResolvedValue(mockIca),
    };
    const multiProvider = {
      getChainName: jest.fn().mockReturnValue('ethereum'),
      getProvider: jest.fn(),
    };
    const service = createService({ icaApp, multiProvider });
    // Mock upsertCommitmentInDB to avoid DB calls
    service.upsertCommitmentInDB = jest.fn().mockResolvedValue(undefined);

    const req = { body: icaPayload, log: mockLogger() };
    const res = mockRes();

    await service.handleCommitment(req, res);

    expect(icaApp.getAccount).toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('routes legacy payload to deriveIcaFromDispatchTx', async () => {
    const multiProvider = {
      getChainName: jest.fn().mockReturnValue('ethereum'),
      getProvider: jest.fn().mockReturnValue({
        getTransactionReceipt: jest.fn().mockResolvedValue(null),
      }),
    };
    const service = createService({ multiProvider });

    const req = { body: legacyPayload, log: mockLogger() };
    const res = mockRes();

    await service.handleCommitment(req, res);

    // Should fail because receipt is null, returning 400
    expect(res.status).toHaveBeenCalledWith(400);
    expect(multiProvider.getProvider).toHaveBeenCalledWith(
      legacyPayload.originDomain,
    );
  });
});

describe('normalizeCalls', () => {
  test('throws on malformed address that bypasses schema', () => {
    expect(() => {
      normalizeCalls([{ to: 'not-an-address', data: '0x', value: '0' }]);
    }).toThrow('address bytes must not be empty');
  });

  test('commitmentFromIcaCalls works with valid normalized calls', () => {
    const result = commitmentFromIcaCalls(
      normalizeCalls([{ to: validAddress, data: '0x', value: '0' }]),
      salt,
    );
    expect(result).toBeDefined();
    expect(result.startsWith('0x')).toBe(true);
  });
});
