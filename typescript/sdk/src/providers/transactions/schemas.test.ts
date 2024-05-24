import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { CallDataSchema, PopulatedTransactionSchema } from './schemas.js';
import { CallData, PopulatedTransaction } from './types.js';

describe('transactions schemas', () => {
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';
  const DATA_MOCK: string = '0xabcdef';
  const CHAIN_ID_MOCK: number = 1;
  const VALUE_MOCK: string = '100';

  const INVALID_ADDRESS: Address = '0x1';

  describe('PopulatedTransactionSchema', () => {
    it('should parse valid PopulatedTransaction', () => {
      const validPopulatedTransaction: PopulatedTransaction = {
        to: ADDRESS_MOCK,
        data: DATA_MOCK,
        chainId: CHAIN_ID_MOCK,
      };
      const result = PopulatedTransactionSchema.safeParse(
        validPopulatedTransaction,
      );
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid PopulatedTransaction', () => {
      const invalidPopulatedTransaction: PopulatedTransaction = {
        to: INVALID_ADDRESS,
        data: DATA_MOCK,
        chainId: CHAIN_ID_MOCK,
      };
      const result = PopulatedTransactionSchema.safeParse(
        invalidPopulatedTransaction,
      );
      expect(result.success).to.be.false;
    });
  });

  describe('CallDataSchema', () => {
    it('should parse valid CallData', () => {
      const validCallData: CallData = {
        to: ADDRESS_MOCK,
        data: DATA_MOCK,
        value: VALUE_MOCK,
      };
      const result = CallDataSchema.safeParse(validCallData);
      expect(result.success).to.be.true;
    });

    it('should parse CallData without optional value', () => {
      const validCallDataWithoutValue: CallData = {
        to: ADDRESS_MOCK,
        data: DATA_MOCK,
      };
      const result = CallDataSchema.safeParse(validCallDataWithoutValue);
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid CallData', () => {
      const invalidCallData: CallData = {
        to: INVALID_ADDRESS,
        data: DATA_MOCK,
        value: VALUE_MOCK,
      };
      const result = CallDataSchema.safeParse(invalidCallData);
      expect(result.success).to.be.false;
    });
  });
});
