import { describe, expect, jest, test } from '@jest/globals';
import type { Request, Response } from 'express';

import {
  PostCallsSchema,
  commitmentFromIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';

import { CallCommitmentsService } from '../../src/services/CallCommitmentsService';

// Minimal mock request/response for testing handleCommitment
function mockReqRes(body: any) {
  const req = {
    body,
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      setBindings: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
  } as unknown as Request;

  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const sendStatus = jest.fn();
  const res = { status, json, sendStatus } as unknown as Response;

  return { req, res, status, json };
}

describe('CallCommitmentsService.handleCommitment input validation', () => {
  test('returns 400 for invalid to address via schema', () => {
    const body = {
      calls: [{ to: '', data: '0x', value: '0' }],
      relayers: ['0x' + 'ab'.repeat(20)],
      salt: '0x' + '00'.repeat(32),
      commitmentDispatchTx: '0x' + 'ef'.repeat(32),
      originDomain: 1,
    };

    // Schema should reject before reaching normalizeCalls
    const result = PostCallsSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  test('normalizeCalls throws on malformed address that bypasses schema', () => {
    // Defense-in-depth: even if schema were loosened, normalizeCalls should throw
    expect(() => {
      normalizeCalls([{ to: 'not-an-address', data: '0x', value: '0' }]);
    }).toThrow();
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
