import { expect } from 'chai';
import { z } from 'zod';

import { ZChainName, ZHash, ZNzUint, ZUWei, ZUint } from './customZodTypes.js';

describe('customZodTypes', () => {
  type TestCase<T> = {
    name: string;
    input: T;
    expectedError?: string;
  };

  describe('ZUint', () => {
    const validTestCases: TestCase<number>[] = [
      { name: 'zero', input: 0 },
      { name: 'positive integer', input: 1 },
      { name: 'larger positive integer', input: 42 },
      { name: 'max safe integer', input: Number.MAX_SAFE_INTEGER },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ZUint.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'negative number',
        input: -1,
        expectedError: 'greater than or equal to 0',
      },
      { name: 'larger negative number', input: -42 },
      { name: 'min safe integer', input: Number.MIN_SAFE_INTEGER },
      { name: 'decimal number', input: 3.14 },
      { name: 'small decimal', input: 0.5 },
      { name: 'another decimal', input: 1.1 },
      { name: 'string number', input: '42' },
      { name: 'null', input: null },
      { name: 'undefined', input: undefined },
      { name: 'boolean', input: true },
      { name: 'object', input: {} },
    ];

    invalidTestCases.forEach(({ name, input, expectedError }) => {
      it(`should reject ${name}`, () => {
        const result = ZUint.safeParse(input);
        expect(result.success).to.be.false;
        if (!result.success && expectedError) {
          expect(result.error.issues[0].message).to.contain(expectedError);
        }
      });
    });
  });

  describe('ZNzUint', () => {
    const validTestCases: TestCase<number>[] = [
      { name: 'positive integer', input: 1 },
      { name: 'larger positive integer', input: 42 },
      { name: 'max safe integer', input: Number.MAX_SAFE_INTEGER },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ZNzUint.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      { name: 'zero', input: 0, expectedError: 'greater than 0' },
      { name: 'negative number', input: -1 },
      { name: 'larger negative number', input: -42 },
      { name: 'decimal number', input: 3.14 },
      { name: 'small decimal', input: 0.5 },
    ];

    invalidTestCases.forEach(({ name, input, expectedError }) => {
      it(`should reject ${name}`, () => {
        const result = ZNzUint.safeParse(input);
        expect(result.success).to.be.false;
        if (!result.success && expectedError) {
          expect(result.error.issues[0].message).to.contain(expectedError);
        }
      });
    });
  });

  describe('ZUWei', () => {
    const validTestCases: TestCase<number | string>[] = [
      { name: 'zero as number', input: 0 },
      { name: 'positive integer', input: 1 },
      { name: 'larger positive integer', input: 1000000 },
      { name: 'zero as string', input: '0' },
      { name: 'positive string number', input: '1' },
      { name: 'larger string number', input: '1000000' },
      { name: 'very large string number', input: '999999999999999999999' },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ZUWei.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      { name: 'alphabetic string', input: 'abc' },
      { name: 'alphanumeric string', input: '123abc' },
      { name: 'decimal string', input: '12.34' },
      { name: 'negative string', input: '-123' },
      { name: 'empty string', input: '' },
      { name: 'string with spaces', input: ' 123 ' },
      { name: 'negative number', input: -1 },
      { name: 'larger negative number', input: -123 },
      { name: 'decimal number', input: 3.14 },
      { name: 'small decimal', input: 0.5 },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ZUWei.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ZHash', () => {
    const validTestCases: TestCase<string>[] = [
      {
        name: '32-byte hex hash',
        input:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      },
      {
        name: '20-byte hex hash',
        input: '0x1234567890abcdef1234567890abcdef12345678',
      },
      { name: '16-byte hex hash', input: '0x1234567890abcdef1234567890abcdef' },
      {
        name: '64-byte hex hash',
        input:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      },
      {
        name: 'base58 hash (32 chars)',
        input: '123456789ABCDEFGHJKLMNPQRSTUVWXYZa',
      },
      {
        name: 'evm address',
        input: '0x1234567890abcdef1234567890abcdef12345678',
      },
      {
        name: 'solana address',
        input: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
      },
      {
        name: 'starknet address',
        input:
          '0x1176a1bd84444c89232ec27754698e5d2e7e1a7f1539f12027f28b23ec9f3d8',
      },
      {
        name: 'bech32 address (bc1)',
        input: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      },
      {
        name: 'bech32 address (cosmos)',
        input: 'cosmos1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ZHash.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<string>[] = [
      {
        name: 'hex without 0x prefix',
        input: '1234567890abcdef1234567890abcdef12345678',
      },
      { name: 'too short hex', input: '0x123' },
      {
        name: 'wrong prefix case',
        input: '0X1234567890abcdef1234567890abcdef12345678',
      },
      { name: 'base58 with wrong length (too short)', input: '123456789ABC' },
      { name: 'empty string', input: '' },
      { name: 'invalid string', input: 'invalid' },
      { name: 'incomplete hex prefix', input: '0x' },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ZHash.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ZChainName', () => {
    const validTestCases: TestCase<string>[] = [
      { name: 'ethereum', input: 'ethereum' },
      { name: 'arbitrum', input: 'arbitrum' },
      { name: 'optimism', input: 'optimism' },
      { name: 'polygon', input: 'polygon' },
      { name: 'avalanche', input: 'avalanche' },
      { name: 'bsc', input: 'bsc' },
      { name: 'fantom', input: 'fantom' },
      { name: 'single letter', input: 'a' },
      { name: 'letter with number', input: 'a1' },
      { name: 'chain with numbers', input: 'chain123' },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ZChainName.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<string>[] = [
      { name: 'starting with number', input: '1ethereum' },
      { name: 'starting with numbers', input: '123chain' },
      { name: 'starting with underscore', input: '_chain' },
      { name: 'starting with dash', input: '-chain' },
      { name: 'uppercase first letter', input: 'Ethereum' },
      { name: 'all uppercase', input: 'ARBITRUM' },
      { name: 'mixed case', input: 'OptImism' },
      { name: 'with dash', input: 'ether-eum' },
      { name: 'with underscore', input: 'arbitrum_one' },
      { name: 'with dot', input: 'optimism.eth' },
      { name: 'with at symbol', input: 'polygon@matic' },
      { name: 'with dash at end', input: 'avalanche-c' },
      { name: 'empty string', input: '' },
      {
        name: 'complex invalid name',
        input: 'Invalid-Chain',
        expectedError: 'Invalid',
      },
    ];

    invalidTestCases.forEach(({ name, input, expectedError }) => {
      it(`should reject ${name}`, () => {
        const result = ZChainName.safeParse(input);
        expect(result.success).to.be.false;
        if (!result.success && expectedError) {
          expect(result.error.issues[0].message).to.contain(expectedError);
        }
      });
    });
  });

  describe('Error handling and edge cases', () => {
    type EdgeCaseTestCase = {
      name: string;
      schema: z.ZodSchema;
      input: unknown;
      expectedSuccess: boolean;
    };

    const edgeCaseTestCases: EdgeCaseTestCase[] = [
      {
        name: 'ZUint with max safe integer',
        schema: ZUint,
        input: Number.MAX_SAFE_INTEGER,
        expectedSuccess: true,
      },
      {
        name: 'ZUint with max safe integer + 1',
        schema: ZUint,
        input: Number.MAX_SAFE_INTEGER + 1,
        expectedSuccess: true,
      },
      {
        name: 'ZUWei with extremely large string',
        schema: ZUWei,
        input:
          '999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999',
        expectedSuccess: true,
      },
      {
        name: 'ZChainName with unicode (éthéreum)',
        schema: ZChainName,
        input: 'ethéreum',
        expectedSuccess: false,
      },
      {
        name: 'ZChainName with unicode (arbitrüm)',
        schema: ZChainName,
        input: 'arbitrüm',
        expectedSuccess: false,
      },
      {
        name: 'ZHash with uppercase hex',
        schema: ZHash,
        input: '0x1234567890ABCDEF1234567890ABCDEF12345678',
        expectedSuccess: true,
      },
      {
        name: 'ZHash with mixed case hex',
        schema: ZHash,
        input: '0x1234567890abcdef1234567890ABCDEF12345678',
        expectedSuccess: true,
      },
    ];

    edgeCaseTestCases.forEach(({ name, schema, input, expectedSuccess }) => {
      it(`should handle ${name}`, () => {
        expect(schema.safeParse(input).success).to.equal(expectedSuccess);
      });
    });
  });
});
