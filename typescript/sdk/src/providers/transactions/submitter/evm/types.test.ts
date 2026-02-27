import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';

import {
  EvmGnosisSafeTxSubmitterProps,
  EvmGnosisSafeTxSubmitterPropsSchema,
  EvmImpersonatedAccountTxSubmitterProps,
  EvmImpersonatedAccountTxSubmitterPropsSchema,
} from './types.js';

describe('evm submitter props schemas', () => {
  const CHAIN_MOCK: ChainName = 'ethereum';
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';

  const INVALID_ADDRESS: Address = '0x1';

  describe('EvmGnosisSafeTxSubmitterPropsSchema', () => {
    it('should parse valid props', () => {
      const validProps: EvmGnosisSafeTxSubmitterProps = {
        chain: CHAIN_MOCK,
        safeAddress: ADDRESS_MOCK,
      };
      const result = EvmGnosisSafeTxSubmitterPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid props', () => {
      const invalidProps = {
        chain: CHAIN_MOCK,
      };
      const result =
        EvmGnosisSafeTxSubmitterPropsSchema.safeParse(invalidProps);
      expect(result.success).to.be.false;
    });
  });

  describe('EvmImpersonatedAccountTxSubmitterPropsSchema', () => {
    it('should parse valid props', () => {
      const validProps: EvmImpersonatedAccountTxSubmitterProps = {
        chain: CHAIN_MOCK,
        userAddress: ADDRESS_MOCK,
      };
      const result =
        EvmImpersonatedAccountTxSubmitterPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid props', () => {
      const invalidProps: EvmImpersonatedAccountTxSubmitterProps = {
        chain: CHAIN_MOCK,
        userAddress: INVALID_ADDRESS,
      };
      const result =
        EvmImpersonatedAccountTxSubmitterPropsSchema.safeParse(invalidProps);
      expect(result.success).to.be.false;
    });
  });
});
