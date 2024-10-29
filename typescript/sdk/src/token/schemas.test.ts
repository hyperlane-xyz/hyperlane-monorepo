import { expect } from 'chai';
import { ethers } from 'ethers';

import { TokenType } from './config.js';
import { WarpRouteDeployConfigSchema } from './schemas.js';

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
];

describe('WarpRouteDeployConfigSchema refine', () => {
  let config: any;
  beforeEach(() => {
    config = {
      arbitrum: {
        type: TokenType.collateral,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
    };
  });

  it('should require token type', () => {
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.type;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should require token address', () => {
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.token;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should require mailbox address', () => {
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    delete config.arbitrum.mailbox;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should throw if collateral type and token is empty', async () => {
    for (const type of COLLATERAL_TYPES) {
      config.arbitrum.type = type;
      config.arbitrum.token = undefined;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      // Set to some address
      config.arbitrum.token = SOME_ADDRESS;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });

  it('should accept native type if token is empty', async () => {
    config.arbitrum.type = TokenType.native;
    config.arbitrum.token = undefined;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
  });

  it('should succeed if non-collateral type, token is empty, metadata is defined', async () => {
    delete config.arbitrum.token;
    config.arbitrum.totalSupply = '0';
    config.arbitrum.name = 'name';

    for (const type of NON_COLLATERAL_TYPES) {
      config.arbitrum.type = type;
      config.arbitrum.symbol = undefined;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      config.arbitrum.symbol = 'symbol';
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });
});
