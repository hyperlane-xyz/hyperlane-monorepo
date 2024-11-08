import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';

import {
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
} from './schemas.js';
import {
  EV5GnosisSafeTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitterProps,
} from './types.js';

describe('ethersV5 submitter props schemas', () => {
  const CHAIN_MOCK: ChainName = 'ethereum';
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';

  const INVALID_ADDRESS: Address = '0x1';

  describe('EV5GnosisSafeTxSubmitterPropsSchema', () => {
    it('should parse valid props', () => {
      const validProps: EV5GnosisSafeTxSubmitterProps = {
        chain: CHAIN_MOCK,
        safeAddress: ADDRESS_MOCK,
      };
      const result = EV5GnosisSafeTxSubmitterPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid props', () => {
      const invalidProps = {
        chain: CHAIN_MOCK,
      };
      const result =
        EV5GnosisSafeTxSubmitterPropsSchema.safeParse(invalidProps);
      expect(result.success).to.be.false;
    });
  });

  describe('EV5ImpersonatedAccountTxSubmitterPropsSchema', () => {
    it('should parse valid props', () => {
      const validProps: EV5ImpersonatedAccountTxSubmitterProps = {
        chain: CHAIN_MOCK,
        userAddress: ADDRESS_MOCK,
      };
      const result =
        EV5ImpersonatedAccountTxSubmitterPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });

    it('should fail parsing invalid props', () => {
      const invalidProps: EV5ImpersonatedAccountTxSubmitterProps = {
        chain: CHAIN_MOCK,
        userAddress: INVALID_ADDRESS,
      };
      const result =
        EV5ImpersonatedAccountTxSubmitterPropsSchema.safeParse(invalidProps);
      expect(result.success).to.be.false;
    });
  });
});
