import { expect } from 'chai';
import { ethers } from 'ethers';
import { constants } from 'ethers';

import { TokenType, WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const COLLATERAL_TYPES = [
  TokenType.collateral,
  TokenType.collateralUri,
  TokenType.fastCollateral,
  TokenType.collateralVault,
];

const NON_COLLATERAL_TYPES = [
  TokenType.synthetic,
  TokenType.syntheticUri,
  TokenType.fastSynthetic,
  TokenType.native,
];

describe('WarpRouteDeployConfigSchema refine', () => {
  it('should require type address', () => {
    const config: any = {
      arbitrum: {
        type: TokenType.collateral,
        token: SOME_ADDRESS,
      },
    };
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.type;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should require token address', () => {
    const config: any = {
      arbitrum: {
        type: TokenType.collateral,
        token: SOME_ADDRESS,
      },
    };
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.token;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should allow mailbox to be optional', () => {
    const config: any = {
      arbitrum: {
        type: TokenType.collateral,
        token: constants.AddressZero,
        mailbox: SOME_ADDRESS,
      },
    };
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.mailbox;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
  });

  it('should throw if collateral type and token is empty', async () => {
    for (const type of COLLATERAL_TYPES) {
      const config: any = {
        arbitrum: {
          type,
          mailbox: SOME_ADDRESS,
          name: 'Arby Coin',
          symbol: 'ARBY',
          totalSupply: '10000',
        },
      };
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      // Set to some address
      config.arbitrum.token = SOME_ADDRESS;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });

  it('should succeed if non-collateral type and token is empty', async () => {
    for (const type of NON_COLLATERAL_TYPES) {
      const config: any = {
        arbitrum: {
          type,
          mailbox: SOME_ADDRESS,
          name: 'Arby Coin',
          symbol: 'ARBY',
          totalSupply: '10000',
        },
      };
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });
});
