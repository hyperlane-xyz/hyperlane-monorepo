import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';

import { TxSubmitterType } from '../TxSubmitterTypes.js';

import {
  EV5GnosisSafeTxSubmitterProps,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
  EV5JsonRpcTxSubmitterProps,
  EV5JsonRpcTxSubmitterPropsSchema,
  EvmIcaTxSubmitterPropsSchema,
  ZEvmAddress,
} from './types.js';

describe('ethersV5 submitter props schemas', () => {
  const CHAIN_MOCK: ChainName = 'ethereum';
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';

  const INVALID_ADDRESS: Address = '0x1';

  // Same address from the run-1 ICA strategy incident: correct hex shape, but a
  // bad EIP-55 checksum. Passed the old ZHash regex, then crashed deep in ethers
  // during ICA submission — after deploys had already run.
  const BAD_CHECKSUM_ADDRESS: Address =
    '0x3f13C1351aC66CA0f4827c607A94C93C82AD0913';
  const GOOD_CHECKSUM_ADDRESS: Address =
    '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913';

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

  describe('EV5JsonRpcTxSubmitterPropsSchema', () => {
    it('should parse and retain accountAddress when provided', () => {
      const validProps: EV5JsonRpcTxSubmitterProps = {
        chain: CHAIN_MOCK,
        privateKey: ADDRESS_MOCK,
        accountAddress: ADDRESS_MOCK,
      };

      const result = EV5JsonRpcTxSubmitterPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.accountAddress).to.equal(ADDRESS_MOCK);
      }
    });
  });

  describe('ZEvmAddress', () => {
    it('should accept a valid EIP-55 checksummed address', () => {
      expect(ZEvmAddress.safeParse(GOOD_CHECKSUM_ADDRESS).success).to.be.true;
    });

    it('should accept an all-lowercase address', () => {
      expect(ZEvmAddress.safeParse(GOOD_CHECKSUM_ADDRESS.toLowerCase()).success)
        .to.be.true;
    });

    it('should reject an address with a bad EIP-55 checksum', () => {
      expect(ZEvmAddress.safeParse(BAD_CHECKSUM_ADDRESS).success).to.be.false;
    });

    it('should reject a malformed address', () => {
      expect(ZEvmAddress.safeParse(INVALID_ADDRESS).success).to.be.false;
    });
  });

  describe('EvmIcaTxSubmitterPropsSchema', () => {
    const baseProps = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: CHAIN_MOCK,
      destinationChain: CHAIN_MOCK,
      internalSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN_MOCK,
      },
    };

    it('should accept a good-checksum owner', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse({
        ...baseProps,
        owner: GOOD_CHECKSUM_ADDRESS,
      });
      expect(result.success).to.be.true;
    });

    it('should accept an all-lowercase owner', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse({
        ...baseProps,
        owner: GOOD_CHECKSUM_ADDRESS.toLowerCase(),
      });
      expect(result.success).to.be.true;
    });

    // Regression for the run-1 ICA strategy incident: a bad-checksum owner
    // passed the old ZHash regex and only crashed during ICA submission, after
    // deploys had already run. It must now fail fast at parse time.
    it('should reject a bad-checksum owner', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse({
        ...baseProps,
        owner: BAD_CHECKSUM_ADDRESS,
      });
      expect(result.success).to.be.false;
    });

    it('should reject a bad-checksum originInterchainAccountRouter', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse({
        ...baseProps,
        owner: GOOD_CHECKSUM_ADDRESS,
        originInterchainAccountRouter: BAD_CHECKSUM_ADDRESS,
      });
      expect(result.success).to.be.false;
    });
  });
});
