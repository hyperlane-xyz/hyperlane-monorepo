import { expect } from 'chai';

import { Address, assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import {
  EV5GnosisSafeTxSubmitterProps,
  EV5GnosisSafeTxSubmitterPropsSchema,
  EV5ImpersonatedAccountTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitterPropsSchema,
  EV5JsonRpcTxSubmitterProps,
  EV5JsonRpcTxSubmitterPropsSchema,
  EvmAccessManagerSubmitterProps,
  EvmAccessManagerSubmitterPropsSchema,
  EvmIcaTxSubmitterProps,
  EvmIcaTxSubmitterPropsSchema,
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
  describe('EvmAccessManagerSubmitterPropsSchema', () => {
    const CALLER_MOCK: Address = '0x9876543210987654321098765432109876543210';

    const validCases: Array<{
      name: string;
      props: EvmAccessManagerSubmitterProps;
    }> = [
      {
        name: 'minimal props',
        props: {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_MOCK,
          accessManagerAddress: ADDRESS_MOCK,
          proposerSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_MOCK,
          },
        },
      },
      {
        name: 'props with caller',
        props: {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_MOCK,
          accessManagerAddress: ADDRESS_MOCK,
          caller: CALLER_MOCK,
          proposerSubmitter: {
            type: TxSubmitterType.GNOSIS_SAFE,
            chain: CHAIN_MOCK,
            safeAddress: CALLER_MOCK,
          },
        },
      },
      {
        name: 'props with a nested interchain account proposer',
        props: {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_MOCK,
          accessManagerAddress: ADDRESS_MOCK,
          proposerSubmitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: 'arbitrum',
            destinationChain: CHAIN_MOCK,
            owner: CALLER_MOCK,
            internalSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: 'arbitrum',
            },
          },
        },
      },
    ];

    for (const { name, props } of validCases) {
      it(`should parse ${name}`, () => {
        const result = EvmAccessManagerSubmitterPropsSchema.safeParse(props);
        expect(result.success).to.be.true;
        assert(result.success, 'Expected parsing to succeed');
        expect(result.data).to.deep.equal(props);
      });
    }

    it('should fail parsing an invalid accessManagerAddress', () => {
      const result = EvmAccessManagerSubmitterPropsSchema.safeParse({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: INVALID_ADDRESS,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
        },
      });
      expect(result.success).to.be.false;
    });

    it('should fail parsing an invalid caller', () => {
      const result = EvmAccessManagerSubmitterPropsSchema.safeParse({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: ADDRESS_MOCK,
        caller: INVALID_ADDRESS,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
        },
      });
      expect(result.success).to.be.false;
    });

    it('should fail parsing when the proposerSubmitter is missing', () => {
      const result = EvmAccessManagerSubmitterPropsSchema.safeParse({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_MOCK,
        accessManagerAddress: ADDRESS_MOCK,
      });
      expect(result.success).to.be.false;
    });
  });

  describe('EvmIcaTxSubmitterPropsSchema', () => {
    const icaProps: EvmIcaTxSubmitterProps = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: CHAIN_MOCK,
      destinationChain: 'arbitrum',
      owner: ADDRESS_MOCK,
      refundAddress: '0x9876543210987654321098765432109876543210',
      internalSubmitter: { type: TxSubmitterType.JSON_RPC, chain: CHAIN_MOCK },
    };

    it('should parse and retain refundAddress when provided', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse(icaProps);
      expect(result.success).to.be.true;
      assert(result.success, 'Expected parsing to succeed');
      expect(result.data.refundAddress).to.equal(icaProps.refundAddress);
    });

    it('should fail parsing an invalid refundAddress', () => {
      const result = EvmIcaTxSubmitterPropsSchema.safeParse({
        type: icaProps.type,
        chain: icaProps.chain,
        destinationChain: icaProps.destinationChain,
        owner: icaProps.owner,
        refundAddress: INVALID_ADDRESS,
        internalSubmitter: icaProps.internalSubmitter,
      });
      expect(result.success).to.be.false;
    });
  });
});
