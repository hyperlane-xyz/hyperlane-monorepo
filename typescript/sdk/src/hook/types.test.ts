import { expect } from 'chai';
import { ethers } from 'ethers';

import { randomAddress } from '../test/testUtils.js';

import { HookConfigSchema, HookType, IgpSchema } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('IgpSchema', () => {
  const baseConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    owner: SOME_ADDRESS,
    beneficiary: SOME_ADDRESS,
    oracleKey: SOME_ADDRESS,
    overhead: { ethereum: 60000 },
    oracleConfig: {
      ethereum: {
        gasPrice: '1000000000',
        tokenExchangeRate: '10000000000',
      },
    },
  };

  it('should parse valid IGP config without tokenOracleConfig', () => {
    const result = IgpSchema.safeParse(baseConfig);
    expect(result.success).to.be.true;
  });

  it('should parse valid IGP config with tokenOracleConfig', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          ethereum: {
            gasPrice: '500000000',
            tokenExchangeRate: '20000000000',
          },
        },
      },
    };
    const result = IgpSchema.safeParse(config);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.tokenOracleConfig).to.not.be.undefined;
      expect(result.data.tokenOracleConfig![feeToken]).to.deep.equal({
        ethereum: {
          gasPrice: '500000000',
          tokenExchangeRate: '20000000000',
        },
      });
    }
  });

  it('should parse config with multiple fee tokens in tokenOracleConfig', () => {
    const feeToken1 = randomAddress();
    const feeToken2 = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken1]: {
          ethereum: {
            gasPrice: '500000000',
            tokenExchangeRate: '20000000000',
          },
        },
        [feeToken2]: {
          ethereum: {
            gasPrice: '1000000000',
            tokenExchangeRate: '15000000000',
          },
          arbitrum: {
            gasPrice: '100000000',
            tokenExchangeRate: '10000000000',
          },
        },
      },
    };
    const result = IgpSchema.safeParse(config);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(Object.keys(result.data.tokenOracleConfig!)).to.have.lengthOf(2);
    }
  });

  it('should parse config with tokenOracleConfig including tokenDecimals', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          ethereum: {
            gasPrice: '500000000',
            tokenExchangeRate: '20000000000',
            tokenDecimals: 6,
          },
        },
      },
    };
    const result = IgpSchema.safeParse(config);
    expect(result.success).to.be.true;
  });

  it('should reject tokenOracleConfig with missing gasPrice', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          ethereum: {
            tokenExchangeRate: '20000000000',
          },
        },
      },
    };
    const result = IgpSchema.safeParse(config);
    expect(result.success).to.be.false;
  });

  it('should reject tokenOracleConfig with missing tokenExchangeRate', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          ethereum: {
            gasPrice: '500000000',
          },
        },
      },
    };
    const result = IgpSchema.safeParse(config);
    expect(result.success).to.be.false;
  });
});

describe('IgpSchema tokenOracleConfig key validation', () => {
  const baseConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    owner: SOME_ADDRESS,
    beneficiary: SOME_ADDRESS,
    oracleKey: SOME_ADDRESS,
    overhead: {},
    oracleConfig: {},
  };

  it('allows non-zero EVM fee-token keys and chain-name remote keys', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          ethereum: { tokenExchangeRate: '1', gasPrice: '1' },
        },
      },
    };
    expect(HookConfigSchema.safeParse(config).success).to.be.true;
  });

  it('rejects zero-address fee-token keys', () => {
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [ZERO_ADDRESS]: {
          ethereum: { tokenExchangeRate: '1', gasPrice: '1' },
        },
      },
    };
    expect(HookConfigSchema.safeParse(config).success).to.be.false;
  });

  it('rejects non-address fee-token keys', () => {
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        NATIVE_TOKEN: {
          ethereum: { tokenExchangeRate: '1', gasPrice: '1' },
        },
      },
    };
    expect(HookConfigSchema.safeParse(config).success).to.be.false;
  });

  it('rejects invalid remote chain keys', () => {
    const feeToken = randomAddress();
    const config = {
      ...baseConfig,
      tokenOracleConfig: {
        [feeToken]: {
          'not-a-chain': { tokenExchangeRate: '1', gasPrice: '1' },
        },
      },
    };
    expect(HookConfigSchema.safeParse(config).success).to.be.false;
  });
});
