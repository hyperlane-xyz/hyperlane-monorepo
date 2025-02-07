import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';

import {
  EV5InterchainAccountTxTransformerProps,
  EV5InterchainAccountTxTransformerPropsSchema,
} from './types.js';

describe('ethersV5 transformer props schemas', () => {
  const CHAIN_MOCK: ChainName = 'ethereum';
  const ORIGIN_MOCK: ChainName = 'arbitrum';
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';
  const HOOK_METADATA_MOCK: string = '1243';

  describe('EV5InterchainAccountTxTransformerProps', () => {
    it('should parse valid props', () => {
      const validProps: EV5InterchainAccountTxTransformerProps = {
        chain: CHAIN_MOCK,
        config: {
          origin: ORIGIN_MOCK,
          owner: ADDRESS_MOCK,
        },
        hookMetadata: HOOK_METADATA_MOCK,
      };
      const result =
        EV5InterchainAccountTxTransformerPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });

    it('should fail parsing props when required fields are missing', () => {
      const invalidProps = {
        chain: CHAIN_MOCK,
      };
      const result =
        EV5InterchainAccountTxTransformerPropsSchema.safeParse(invalidProps);
      expect(result.success).to.be.false;
    });

    it('should parse props when extra fields are present', () => {
      const validProps = {
        chain: CHAIN_MOCK,
        config: {
          origin: ORIGIN_MOCK,
          owner: ADDRESS_MOCK,
        },
        miscData: 1234,
        nonsense: 'bleh',
        ish: true,
      };
      const result =
        EV5InterchainAccountTxTransformerPropsSchema.safeParse(validProps);
      expect(result.success).to.be.true;
    });
  });
});
