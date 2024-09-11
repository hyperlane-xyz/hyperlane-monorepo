import { expect } from 'chai';
import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import { TokenType } from './config.js';
import {
  WarpRouteDeployConfigSchema,
  WarpRouteDeployConfigSchemaErrors,
} from './schemas.js';

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

describe.only('WarpRouteDeployConfigSchema refine', () => {
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

  it('should throw if deploying rebasing collateral with anything other than rebasing synthetic', async () => {
    config = {
      arbitrum: {
        type: TokenType.collateralVaultRebase,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
      ethereum: {
        type: TokenType.collateralVault,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
      optimism: {
        type: TokenType.syntheticRebase,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
    };
    let parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    expect(parseResults.success).to.be.false;
    assert(!parseResults.success, 'must be false'); // Need so message shows up because parseResults is a discriminate union
    expect(parseResults.error.issues[0].message).to.equal(
      WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
    );

    config.ethereum.type = TokenType.syntheticRebase;
    parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    expect(parseResults.success).to.be.true;
  });
});
