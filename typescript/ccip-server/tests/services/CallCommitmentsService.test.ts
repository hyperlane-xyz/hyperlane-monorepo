import { describe, expect, jest, test } from '@jest/globals';

import { commitmentFromIcaCalls, normalizeCalls } from '@hyperlane-xyz/sdk';

import { CallCommitmentsService } from '../../src/services/CallCommitmentsService';

function mockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
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

describe('CallCommitmentsService.handleCommitment input validation', () => {
  test('returns 400 when schema rejects invalid to address', async () => {
    const logger = mockLogger();
    const service = Object.create(CallCommitmentsService.prototype);
    service.addLoggerServiceContext = () => logger;

    const req = {
      body: {
        calls: [{ to: '', data: '0x', value: '0' }],
        relayers: ['0x' + 'ab'.repeat(20)],
        salt: '0x' + '00'.repeat(32),
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

  test('normalizeCalls throws on malformed address that bypasses schema', () => {
    expect(() => {
      normalizeCalls([{ to: 'not-an-address', data: '0x', value: '0' }]);
    }).toThrow('address bytes must not be empty');
  });

  test('commitmentFromIcaCalls works with valid normalized calls', () => {
    const validAddress = '0x' + 'ab'.repeat(20);
    const salt = '0x' + '00'.repeat(32);
    const result = commitmentFromIcaCalls(
      normalizeCalls([{ to: validAddress, data: '0x', value: '0' }]),
      salt,
    );
    expect(result).toBeDefined();
    expect(result.startsWith('0x')).toBe(true);
  });
});
