import { expect } from 'chai';
import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import { TokenFeeType } from '../fee/types.js';

import { TokenType } from './config.js';
import {
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  WarpRouteDeployConfigSchemaErrors,
  isCollateralTokenConfig,
} from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const COLLATERAL_TYPES = [
  TokenType.collateral,
  TokenType.collateralUri,
  TokenType.collateralVault,
];

const NON_COLLATERAL_TYPES = [TokenType.synthetic, TokenType.syntheticUri];

describe('WarpRouteDeployConfigSchema refine', () => {
  let config: WarpRouteDeployConfig;
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

    //@ts-ignore
    delete config.arbitrum.type;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should require token address', () => {
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;

    //@ts-ignore
    delete config.arbitrum.token;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;
  });

  it('should not require mailbox address', () => {
    //@ts-ignore
    delete config.arbitrum.mailbox;
    expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
  });

  it('should throw if collateral type and token is empty', async () => {
    for (const type of COLLATERAL_TYPES) {
      config.arbitrum.type = type;
      assert(isCollateralTokenConfig(config.arbitrum), 'must be collateral');

      //@ts-ignore
      config.arbitrum.token = undefined;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      // Set to some address
      config.arbitrum.token = SOME_ADDRESS;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });

  it('should succeed if non-collateral type, token is empty, metadata is defined', async () => {
    //@ts-ignore
    delete config.arbitrum.token;
    config.arbitrum.name = 'name';

    for (const type of NON_COLLATERAL_TYPES) {
      config.arbitrum.type = type;
      config.arbitrum.symbol = undefined;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      config.arbitrum.symbol = 'symbol';
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });

  it(`should throw if deploying rebasing collateral with anything other than ${TokenType.syntheticRebase}`, async () => {
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
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        collateralChainName: '',
      },
    };
    let parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    assert(!parseResults.success, 'must be false'); // Needed so 'message' shows up because parseResults is a discriminate union
    expect(parseResults.error.issues[0].message).to.equal(
      WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
    );

    config.ethereum.type = TokenType.syntheticRebase;
    //@ts-ignore
    config.ethereum.collateralChainName = '';
    parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    //@ts-ignore
    expect(parseResults.success).to.be.true;
  });

  it(`should throw if deploying only ${TokenType.collateralVaultRebase}`, async () => {
    config = {
      arbitrum: {
        type: TokenType.collateralVaultRebase,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
    };
    let parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    expect(parseResults.success).to.be.false;

    config.ethereum = {
      type: TokenType.collateralVaultRebase,
      token: SOME_ADDRESS,
      owner: SOME_ADDRESS,
      mailbox: SOME_ADDRESS,
    };
    parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    expect(parseResults.success).to.be.false;
  });

  it(`should derive the collateral chain name for ${TokenType.syntheticRebase}`, async () => {
    config = {
      arbitrum: {
        type: TokenType.collateralVaultRebase,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
      },
      ethereum: {
        type: TokenType.syntheticRebase,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        collateralChainName: '',
      },
      optimism: {
        type: TokenType.syntheticRebase,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        collateralChainName: '',
      },
    };
    const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
    assert(parseResults.success, 'must be true');
    const warpConfig: WarpRouteDeployConfig = parseResults.data;

    assert(
      warpConfig.optimism.type === TokenType.syntheticRebase,
      'must be syntheticRebase',
    );
    expect(warpConfig.optimism.collateralChainName).to.equal('arbitrum');
  });

  describe('tokenFee input schema', () => {
    it('should accept LinearFee without token field', () => {
      const parseResults = WarpRouteDeployConfigSchema.safeParse({
        arbitrum: {
          type: TokenType.synthetic,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          name: 'Test Token',
          symbol: 'TEST',
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100n,
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.arbitrum.tokenFee?.type).to.equal(
        TokenFeeType.LinearFee,
      );
    });

    it('should accept RoutingFee without token field', () => {
      const parseResults = WarpRouteDeployConfigSchema.safeParse({
        arbitrum: {
          type: TokenType.synthetic,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          name: 'Test Token',
          symbol: 'TEST',
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            feeContracts: {
              ethereum: {
                type: TokenFeeType.LinearFee,
                bps: 100n,
              },
            },
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.arbitrum.tokenFee?.type).to.equal(
        TokenFeeType.RoutingFee,
      );
    });

    it('should accept tokenFee for collateral tokens', () => {
      const parseResults = WarpRouteDeployConfigSchema.safeParse({
        ethereum: {
          type: TokenType.collateral,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100n,
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.ethereum.tokenFee?.type).to.equal(
        TokenFeeType.LinearFee,
      );
    });

    it('should accept tokenFee for native tokens', () => {
      const parseResults = WarpRouteDeployConfigSchema.safeParse({
        arbitrum: {
          type: TokenType.native,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100n,
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.arbitrum.tokenFee?.type).to.equal(
        TokenFeeType.LinearFee,
      );
    });

    it('should populate owner from token config if not specified', () => {
      const parseResults = WarpRouteDeployConfigSchema.safeParse({
        arbitrum: {
          type: TokenType.synthetic,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          name: 'Test Token',
          symbol: 'TEST',
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100n,
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.arbitrum.tokenFee?.owner).to.equal(SOME_ADDRESS);
    });
  });

  describe('xERC20 validation', () => {
    it('should allow xERC20 with xERC20Lockbox', () => {
      const config = {
        ethereum: {
          type: TokenType.XERC20Lockbox,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        arbitrum: {
          type: TokenType.XERC20,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
      };
      const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
      expect(parseResults.success).to.be.true;
    });

    it('should allow xERC20 with collateral', () => {
      const config = {
        ethereum: {
          type: TokenType.collateral,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        arbitrum: {
          type: TokenType.XERC20,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
      };
      const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
      expect(parseResults.success).to.be.true;
    });

    it('should allow multiple xERC20 chains', () => {
      const config = {
        ethereum: {
          type: TokenType.XERC20Lockbox,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        arbitrum: {
          type: TokenType.XERC20,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        optimism: {
          type: TokenType.XERC20,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
      };
      const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
      expect(parseResults.success).to.be.true;
    });

    for (const invalidType of [TokenType.synthetic, TokenType.native]) {
      it(`should reject xERC20 with ${invalidType}`, () => {
        const config = {
          ethereum: {
            type: TokenType.XERC20,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          arbitrum: {
            type: invalidType,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        };
        const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
        assert(!parseResults.success, 'must be false');
        expect(parseResults.error.issues[0].message).to.equal(
          'xERC20 warp routes must only contain xERC20 or collateral token types',
        );
      });
    }
  });
});
