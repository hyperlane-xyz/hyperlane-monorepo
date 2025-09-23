import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import {
  AccessManagerSubmitterConfig,
  AccessManagerSubmitterConfigSchema,
  EV5GnosisSafeTxSubmitterProps,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
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

  describe('AccessManagerSubmitterConfigSchema', () => {
    const mockProposerSubmitter = {
      type: TxSubmitterType.JSON_RPC as const,
      chain: CHAIN_MOCK,
    };

    it('should parse valid AccessManager config', () => {
      const validConfig: AccessManagerSubmitterConfig = {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: ADDRESS_MOCK,
        proposerSubmitter: mockProposerSubmitter,
      };
      const result = AccessManagerSubmitterConfigSchema.safeParse(validConfig);
      expect(result.success).to.be.true;
    });

    it('should parse valid AccessManager config with optional fields', () => {
      const validConfig: AccessManagerSubmitterConfig = {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: ADDRESS_MOCK,
        proposerSubmitter: mockProposerSubmitter,
      };
      const result = AccessManagerSubmitterConfigSchema.safeParse(validConfig);
      expect(result.success).to.be.true;
    });

    it('should fail parsing AccessManager config with missing fields', () => {
      const invalidConfig = {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: ADDRESS_MOCK,
        // Missing proposerSubmitter
      };
      const result =
        AccessManagerSubmitterConfigSchema.safeParse(invalidConfig);
      expect(result.success).to.be.false;
    });

    it('should fail parsing AccessManager config with invalid address', () => {
      const invalidConfig: AccessManagerSubmitterConfig = {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: INVALID_ADDRESS,
        proposerSubmitter: mockProposerSubmitter,
      };
      const result =
        AccessManagerSubmitterConfigSchema.safeParse(invalidConfig);
      expect(result.success).to.be.false;
    });
  });
});
