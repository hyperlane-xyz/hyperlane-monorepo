import { expect } from 'chai';
import { ethers } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import {
  assert,
  stringifyObject,
  tryParseJsonOrYaml,
} from '@hyperlane-xyz/utils';

import { TokenFeeConfigInput, TokenFeeType } from '../fee/types.js';
import { IsmType } from '../ism/types.js';

import { TokenType } from './config.js';
import {
  DerivedTokenRouterConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  WarpRouteDeployConfigSchemaErrors,
  HypTokenRouterConfigMailboxOptionalSchema,
  XERC20AevoCapType,
  XERC20TokenConfigSchema,
  XERC20Type,
  assertFeeHookSupported,
  assertTokenFeeDeploySupported,
  assertTokenFeeUpdateSupported,
  isCollateralTokenConfig,
} from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const COLLATERAL_TYPES = [
  TokenType.collateral,
  TokenType.collateralUri,
  TokenType.collateralVault,
];

const NON_COLLATERAL_TYPES = [TokenType.synthetic, TokenType.syntheticUri];
const FEE_HOOK_UNSUPPORTED_TYPES = [
  TokenType.collateralFiat,
  TokenType.collateralVault,
  TokenType.collateralVaultRebase,
  TokenType.XERC20,
  TokenType.XERC20Lockbox,
];

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

  it('should reject timelock with ownerOverrides.proxyAdmin', () => {
    const result = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        ...config.arbitrum,
        ownerOverrides: {
          proxyAdmin: SOME_ADDRESS,
        },
        timelock: {
          delay: 259200,
          roles: {
            executor: SOME_ADDRESS,
            proposer: SOME_ADDRESS,
          },
        },
      },
    });

    expect(result.success).to.be.false;
    if (!result.success) {
      expect(result.error.issues[0].message).to.equal(
        'Cannot configure timelock with ownerOverrides.proxyAdmin',
      );
    }
  });

  it('should accept deposit-address bridge config', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: '1000',
            },
          },
        },
      },
    });

    assert(parseResults.success, 'must be true');
  });

  it('should reject invalid deposit-address bridge config', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: '0x1234',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
  });

  it('should reject deposit-address bridge config with feeBps above 10000', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: '10001',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
  });

  it('should reject deposit-address bridge config with feeBps of 10000', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: '10000',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
  });

  it('should reject deposit-address bridge config with invalid feeBps string', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: 'abc',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
  });

  it('should reject deposit-address bridge config with empty feeBps string', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: '',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
  });

  it('should reject deposit-address bridge config with negative feeBps', () => {
    const parseResults = WarpRouteDeployConfigSchema.safeParse({
      arbitrum: {
        type: TokenType.collateralDepositAddress,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        destinationConfigs: {
          ethereum: {
            [ethers.utils.hexZeroPad(SOME_ADDRESS, 32)]: {
              depositAddress: SOME_ADDRESS,
              feeBps: '-1',
            },
          },
        },
      },
    });

    expect(parseResults.success).to.be.false;
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

  describe('delayed flow router remoteIsms', () => {
    const REMOTE_ISM_BYTES32 = ethers.utils.hexZeroPad(
      '0x3333333333333333333333333333333333333333',
      32,
    );

    function configWithDelayedFlow(remoteIsms?: Record<string, string>) {
      return {
        arbitrum: {
          type: TokenType.collateral,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            threshold: 2,
            modules: [
              { type: IsmType.TRUSTED_RELAYER, relayer: SOME_ADDRESS },
              {
                type: IsmType.DELAYED_FLOW_ROUTER,
                thresholdBps: 10000,
                maxDelay: 3600,
                duration: 86400n,
                owner: SOME_ADDRESS,
                remoteIsms,
              },
            ],
          },
        },
      };
    }

    it('accepts a delayed flow router without remoteIsms', () => {
      expect(
        WarpRouteDeployConfigSchema.safeParse(configWithDelayedFlow()).success,
      ).to.be.true;
    });

    it('accepts an operator-supplied remoteIsms', () => {
      // `warp read` emits the field, so rejecting it would break the
      // read -> edit -> apply round trip; the value is honoured verbatim by
      // both the expected config and the enrollment transactions.
      const parseResults = WarpRouteDeployConfigSchema.safeParse(
        configWithDelayedFlow({ ethereum: REMOTE_ISM_BYTES32 }),
      );
      assert(parseResults.success, 'expected remoteIsms to be accepted');

      const ism = parseResults.data.arbitrum.interchainSecurityModule;
      assert(
        typeof ism === 'object' && ism.type === IsmType.AGGREGATION,
        'expected an aggregation ism',
      );
      const delayedNode = ism.modules.find(
        (module) =>
          typeof module === 'object' &&
          module.type === IsmType.DELAYED_FLOW_ROUTER,
      );
      assert(
        typeof delayedNode === 'object' &&
          delayedNode.type === IsmType.DELAYED_FLOW_ROUTER,
        'expected a delayed flow router node',
      );
      expect(delayedNode.remoteIsms).to.deep.equal({
        ethereum: REMOTE_ISM_BYTES32,
      });
    });
  });

  describe('tokenFee input schema', () => {
    const tokenFeeUnsupportedConfigs = [
      {
        type: TokenType.collateralFiat,
        token: SOME_ADDRESS,
      },
      {
        type: TokenType.collateralVault,
        token: SOME_ADDRESS,
      },
      {
        type: TokenType.collateralVaultRebase,
        token: SOME_ADDRESS,
      },
      {
        type: TokenType.syntheticRebase,
        name: 'Test Token',
        symbol: 'TEST',
        collateralChainName: 'ethereum',
      },
    ];

    for (const config of tokenFeeUnsupportedConfigs) {
      it(`should reject tokenFee for ${config.type} tokens`, () => {
        const unsupportedConfig = {
          ...config,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100,
          },
        };
        const parseResults =
          HypTokenRouterConfigMailboxOptionalSchema.safeParse(
            unsupportedConfig,
          );

        expect(parseResults.success).to.be.false;
        expect(() =>
          assertTokenFeeDeploySupported(unsupportedConfig, 'test'),
        ).to.throw(
          `${WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UNSUPPORTED} ${config.type} on test`,
        );
      });
    }

    for (const type of [TokenType.XERC20, TokenType.XERC20Lockbox]) {
      it(`should accept existing tokenFee config but reject new ${type} deployments`, () => {
        const config = {
          type,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          contractVersion: '2.0.0',
          tokenFee: {
            type: TokenFeeType.LinearFee,
            bps: 100,
          },
        };

        expect(
          HypTokenRouterConfigMailboxOptionalSchema.safeParse(config).success,
        ).to.be.true;
        expect(() => assertTokenFeeDeploySupported(config, 'test')).to.throw(
          `${WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UNSUPPORTED} ${type} on test`,
        );
      });
    }

    describe('assertTokenFeeUpdateSupported', () => {
      const FEE: TokenFeeConfigInput = {
        type: TokenFeeType.LinearFee,
        bps: 100,
      };
      const DEPLOYED_FEE: DerivedTokenRouterConfig['tokenFee'] = {
        type: TokenFeeType.LinearFee,
        address: SOME_ADDRESS,
        token: SOME_ADDRESS,
        owner: SOME_ADDRESS,
        bps: 100,
        maxFee: 1n,
        halfAmount: 50n,
      };
      const CURRENT_VERSION = '12.2.0';
      const NEWER_VERSION = '13.0.0';

      interface Case {
        name: string;
        expectedTokenFee?: TokenFeeConfigInput;
        expectedVersion?: string;
        actualTokenFee?: DerivedTokenRouterConfig['tokenFee'];
        actualVersion?: string;
        error?: string;
      }

      const cases: Case[] = [
        {
          name: 'rejects adding a fee without a contract version',
          expectedTokenFee: FEE,
          actualVersion: CURRENT_VERSION,
          error: WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UNSUPPORTED,
        },
        {
          name: 'rejects adding a fee at the current contract version',
          expectedTokenFee: FEE,
          expectedVersion: CURRENT_VERSION,
          actualVersion: CURRENT_VERSION,
          error: WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UNSUPPORTED,
        },
        {
          name: 'rejects adding a fee while upgrading',
          expectedTokenFee: FEE,
          expectedVersion: NEWER_VERSION,
          actualVersion: CURRENT_VERSION,
          error: WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UNSUPPORTED,
        },
        {
          name: 'accepts updating an existing fee without a contract version',
          expectedTokenFee: FEE,
          actualTokenFee: DEPLOYED_FEE,
          actualVersion: CURRENT_VERSION,
        },
        {
          name: 'accepts updating an existing fee at the current contract version',
          expectedTokenFee: FEE,
          expectedVersion: CURRENT_VERSION,
          actualTokenFee: DEPLOYED_FEE,
          actualVersion: CURRENT_VERSION,
        },
        {
          name: 'rejects keeping an existing fee while upgrading',
          expectedTokenFee: FEE,
          expectedVersion: NEWER_VERSION,
          actualTokenFee: DEPLOYED_FEE,
          actualVersion: CURRENT_VERSION,
          error:
            WarpRouteDeployConfigSchemaErrors.TOKEN_FEE_UPGRADE_UNSUPPORTED,
        },
        {
          name: 'accepts removing an existing fee while upgrading',
          expectedVersion: NEWER_VERSION,
          actualTokenFee: DEPLOYED_FEE,
          actualVersion: CURRENT_VERSION,
        },
        {
          name: 'accepts routes without fees',
          actualVersion: CURRENT_VERSION,
        },
      ];

      for (const type of [TokenType.XERC20, TokenType.XERC20Lockbox]) {
        for (const c of cases) {
          it(`${c.name} for ${type}`, () => {
            const config = {
              type,
              contractVersion: c.expectedVersion,
              tokenFee: c.expectedTokenFee,
            };
            const actualConfig = {
              contractVersion: c.actualVersion,
              tokenFee: c.actualTokenFee,
            };

            const assertSupported = () =>
              assertTokenFeeUpdateSupported(config, actualConfig, 'test');

            if (c.error) {
              expect(assertSupported).to.throw(`${c.error} ${type} on test`);
            } else {
              expect(assertSupported).not.to.throw();
            }
          });
        }
      }

      it('accepts adding a fee to a synthetic route', () => {
        const config = {
          type: TokenType.synthetic,
          tokenFee: FEE,
        };
        const actualConfig = { contractVersion: CURRENT_VERSION };

        const assertSupported = () =>
          assertTokenFeeUpdateSupported(config, actualConfig, 'test');

        expect(assertSupported).not.to.throw();
      });
    });

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
            bps: 100,
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
                bps: 100,
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
            bps: 100,
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
            bps: 100,
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
            bps: 100,
          },
        },
      });

      assert(parseResults.success, 'must be true');
      expect(parseResults.data.arbitrum.tokenFee?.owner).to.equal(SOME_ADDRESS);
    });
  });

  describe('feeHook input schema', () => {
    for (const type of FEE_HOOK_UNSUPPORTED_TYPES) {
      it(`should reject feeHook for ${type} tokens and allow its removal`, () => {
        const config = {
          type,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        };
        const configuredFeeHook = {
          ...config,
          feeHook: SOME_ADDRESS,
        };

        expect(
          HypTokenRouterConfigMailboxOptionalSchema.safeParse(configuredFeeHook)
            .success,
        ).to.be.false;
        expect(() =>
          assertFeeHookSupported(config, 'test', SOME_ADDRESS),
        ).to.throw(
          `${WarpRouteDeployConfigSchemaErrors.FEE_HOOK_UNSUPPORTED} ${config.type} on test`,
        );
        expect(
          HypTokenRouterConfigMailboxOptionalSchema.safeParse({
            ...config,
            feeHook: ethers.constants.AddressZero,
          }).success,
        ).to.be.true;
        expect(() =>
          assertFeeHookSupported(
            { ...config, feeHook: ethers.constants.AddressZero },
            'test',
            SOME_ADDRESS,
          ),
        ).not.to.throw();
      });
    }

    it('should accept feeHook for syntheticRebase tokens', () => {
      const config = {
        type: TokenType.syntheticRebase,
        name: 'Test Token',
        symbol: 'TEST',
        collateralChainName: 'ethereum',
        owner: SOME_ADDRESS,
        mailbox: SOME_ADDRESS,
        feeHook: SOME_ADDRESS,
      };

      expect(
        HypTokenRouterConfigMailboxOptionalSchema.safeParse(config).success,
      ).to.be.true;
      expect(() => assertFeeHookSupported(config, 'test')).not.to.throw();
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

  describe('feeHook', () => {
    it('should accept config with feeHook', () => {
      config.arbitrum.feeHook = SOME_ADDRESS;
      const result = WarpRouteDeployConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept config without feeHook', () => {
      const result = WarpRouteDeployConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });
});

describe('XERC20TokenConfigSchema Aevo limits', () => {
  const xERC20Config = (warpRouteLimits: unknown, extraBridges?: unknown) => ({
    type: TokenType.XERC20,
    token: SOME_ADDRESS,
    xERC20: { warpRouteLimits, extraBridges },
  });

  const POSITIVE_MESSAGE = 'Must be positive';
  const UINT256_MESSAGE = 'A raw Aevo cap must fit a uint256';
  const EXTRA_BRIDGE_MESSAGE =
    'Aevo limits apply to the router only: extra minters of an Aevo token are not modelled';
  const ROUTER_ONLY_MESSAGE =
    "An Aevo token's limits apply to the router only: extraBridges are not supported for it";
  const STANDARD_LIMITS = { type: XERC20Type.Standard, mint: '1', burn: '1' };
  const VELO_LIMITS = {
    type: XERC20Type.Velo,
    bufferCap: '1',
    rateLimitPerSecond: '1',
  };

  describe('accepted', () => {
    interface Case {
      name: string;
      // As it is written.
      limits: object;
      // As it is parsed, when that is not as it is written.
      parsed?: object;
    }

    const rawCap = (value: unknown): object => ({
      type: XERC20Type.Aevo,
      authorized: true,
      cap: { type: XERC20AevoCapType.Raw, value },
    });
    const parsedRawCap = (value: string): object => rawCap(value);

    const cases: Case[] = [
      {
        name: 'a minter that is not authorized',
        limits: { type: XERC20Type.Aevo, authorized: false },
      },
      {
        name: 'an authorized minter without a bound',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Unlimited },
        },
      },
      // A raw cap is parsed to a canonical decimal string, whatever form it is
      // written in.
      {
        name: 'a raw cap written as a decimal string',
        limits: rawCap('1000'),
        parsed: parsedRawCap('1000'),
      },
      {
        name: 'a raw cap written as a safe integer',
        limits: rawCap(1000),
        parsed: parsedRawCap('1000'),
      },
      {
        name: 'a raw cap written as a bigint',
        limits: rawCap(1000n),
        parsed: parsedRawCap('1000'),
      },
      {
        name: 'a raw cap of one',
        limits: rawCap('1'),
        parsed: parsedRawCap('1'),
      },
      {
        name: 'a raw cap written as a decimal string with a leading zero',
        limits: rawCap('01000'),
        parsed: parsedRawCap('1000'),
      },
      {
        name: 'the largest raw cap a uint256 holds, as a string',
        limits: rawCap(ethers.constants.MaxUint256.toString()),
        parsed: parsedRawCap(ethers.constants.MaxUint256.toString()),
      },
      {
        name: 'the largest raw cap a uint256 holds, as a bigint',
        limits: rawCap(ethers.constants.MaxUint256.toBigInt()),
        parsed: parsedRawCap(ethers.constants.MaxUint256.toString()),
      },
      // The strings a registry file holds, which the rows above, written
      // through the enum, do not pin: renaming an enum value fails only these.
      {
        name: 'an unlimited cap in its wire form',
        limits: {
          type: 'aevo',
          authorized: true,
          cap: { type: 'unlimited' },
        },
      },
      {
        name: 'a raw cap in its wire form',
        limits: {
          type: 'aevo',
          authorized: true,
          cap: { type: 'raw', value: '1000000' },
        },
        parsed: parsedRawCap('1000000'),
      },
    ];

    for (const c of cases) {
      it(`accepts ${c.name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(c.limits),
        );

        expect(result.success).to.equal(true);
        assert(result.success, 'Expected the Aevo limits to parse');
        expect(result.data.xERC20?.warpRouteLimits).to.deep.equal(
          c.parsed ?? c.limits,
        );
      });
    }

    // A cap above 2^53 is the case a number would silently round. It is held
    // as a decimal string, so a file carries it quoted and reads it back
    // exactly.
    const largeCaps = [10n ** 18n, ethers.constants.MaxUint256.toBigInt()];
    const configWithCap = (value: unknown) => ({
      type: TokenType.XERC20,
      token: SOME_ADDRESS,
      xERC20: { warpRouteLimits: rawCap(value) },
    });

    for (const cap of largeCaps) {
      it(`reads back a derived raw cap of ${cap} as stringifyObject writes it`, () => {
        const derived = configWithCap(cap.toString());

        const written = stringifyObject(derived, 'yaml');
        const file = tryParseJsonOrYaml(written);
        assert(file.success, 'Expected the file to parse');
        const result = XERC20TokenConfigSchema.safeParse(file.data);

        // A string in the file, as a number would have been rounded.
        expect(file.data.xERC20.warpRouteLimits.cap.value).to.equal(
          cap.toString(),
        );
        assert(result.success, 'Expected the file to parse');
        expect(result.data).to.deep.equal(derived);
      });

      // What a deploy does: the config a user wrote is parsed, and the parsed
      // config is written to the registry, whose writer is a plain stringify of
      // the yaml package (toYamlString of @hyperlane-xyz/registry, which the
      // SDK does not depend on, with the same options). A bigint would be
      // written as an integer that reads back as a rounded number.
      it(`reads back a raw cap of ${cap} as the registry writes a parsed config`, () => {
        const parsed = XERC20TokenConfigSchema.parse(configWithCap(cap));

        const written = yamlStringify(parsed, {
          indent: 2,
          sortMapEntries: true,
          aliasDuplicateObjects: false,
        });
        const file = tryParseJsonOrYaml(written);
        assert(file.success, 'Expected the registry file to parse');
        const result = XERC20TokenConfigSchema.safeParse(file.data);

        // A string in the file, as a number would have been rounded.
        expect(file.data.xERC20.warpRouteLimits.cap.value).to.equal(
          cap.toString(),
        );
        assert(result.success, 'Expected the registry file to parse');
        expect(result.data).to.deep.equal(parsed);
        expect(result.data.xERC20?.warpRouteLimits).to.deep.equal(
          parsedRawCap(cap.toString()),
        );
      });
    }

    // The control of the rejections below: the refinement turns away Aevo
    // limits alone, not every entry of extraBridges.
    interface ExtraBridgesCase {
      name: string;
      warpRouteLimits: object;
      extraBridgeLimits: object;
    }

    const extraBridgesCases: ExtraBridgesCase[] = [
      {
        name: 'Standard limits as an extra bridge of a Standard route',
        warpRouteLimits: { type: XERC20Type.Standard, mint: '1', burn: '1' },
        extraBridgeLimits: { type: XERC20Type.Standard, mint: '2', burn: '2' },
      },
      {
        name: 'Velodrome limits as an extra bridge of a Velodrome route',
        warpRouteLimits: {
          type: XERC20Type.Velo,
          bufferCap: '1',
          rateLimitPerSecond: '1',
        },
        extraBridgeLimits: {
          type: XERC20Type.Velo,
          bufferCap: '2',
          rateLimitPerSecond: '2',
        },
      },
    ];

    for (const c of extraBridgesCases) {
      it(`accepts ${c.name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(c.warpRouteLimits, [
            { lockbox: SOME_ADDRESS, limits: c.extraBridgeLimits },
          ]),
        );

        expect(result.success).to.equal(true);
      });
    }

    // A route over an Aevo token lists no extra bridge: absent and empty are
    // the same.
    const noExtraBridges: [string, unknown][] = [
      ['absent', undefined],
      ['empty', []],
    ];

    for (const [name, extraBridges] of noExtraBridges) {
      it(`accepts Aevo limits with extraBridges ${name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(
            { type: XERC20Type.Aevo, authorized: false },
            extraBridges,
          ),
        );

        expect(result.success).to.equal(true);
      });
    }

    it('accepts a config that declares no xERC20 limits at all', () => {
      const result = XERC20TokenConfigSchema.safeParse({
        type: TokenType.XERC20,
        token: SOME_ADDRESS,
      });

      expect(result.success).to.equal(true);
    });
  });

  describe('rejected', () => {
    interface Case {
      name: string;
      limits: unknown;
      // The code of the one issue, and where it points.
      code: string;
      path: string;
    }

    const CAP_PATH = 'xERC20.warpRouteLimits.cap';
    const rawCap = (value: unknown) => ({
      type: XERC20Type.Aevo,
      authorized: true,
      cap: { type: XERC20AevoCapType.Raw, value },
    });

    // What the refinements turn away, which is a number the schema of a big
    // number accepts: each says why in its own message. Zero is how the token
    // leaves a minter without a bound, which a config declares as unlimited.
    interface RefinedCase {
      name: string;
      value: unknown;
      message: string;
    }

    const refinedCases: RefinedCase[] = [
      {
        name: "a raw value of '0', which is not how a minter is left unbound",
        value: '0',
        message: POSITIVE_MESSAGE,
      },
      { name: 'a raw value of 0', value: 0, message: POSITIVE_MESSAGE },
      { name: 'a raw value of 0n', value: 0n, message: POSITIVE_MESSAGE },
      {
        name: "a raw value of '00', which is zero",
        value: '00',
        message: POSITIVE_MESSAGE,
      },
      { name: 'a negative bigint', value: -1n, message: POSITIVE_MESSAGE },
      {
        name: 'a decimal string beyond a uint256',
        value: ethers.constants.MaxUint256.add(1).toString(),
        message: UINT256_MESSAGE,
      },
      {
        name: 'a bigint beyond a uint256',
        value: ethers.constants.MaxUint256.add(1).toBigInt(),
        message: UINT256_MESSAGE,
      },
    ];

    for (const c of refinedCases) {
      it(`rejects ${c.name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(rawCap(c.value)),
        );

        expect(result.success).to.equal(false);
        assert(!result.success, 'Expected the Aevo limits to be rejected');
        expect(result.error.issues).to.have.lengthOf(1);
        const [issue] = result.error.issues;
        expect(issue.code).to.equal('custom');
        expect(issue.message).to.equal(c.message);
        expect(issue.path.join('.')).to.equal(`${CAP_PATH}.value`);
      });
    }

    const cases: Case[] = [
      // What the schema of a big number turns away, with the code it does so
      // with.
      {
        name: "a raw value of '-1'",
        limits: rawCap('-1'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a negative safe integer',
        limits: rawCap(-1),
        code: 'too_small',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a fractional string',
        limits: rawCap('1.5'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a fractional number',
        limits: rawCap(1.5),
        code: 'invalid_union',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a string in exponent form',
        limits: rawCap('1e3'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a string in hex',
        limits: rawCap('0x10'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a string with a space',
        limits: rawCap(' 1'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'an empty string',
        limits: rawCap(''),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: "the string 'unlimited'",
        limits: rawCap('unlimited'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a string that is a word',
        limits: rawCap('infinite'),
        code: 'invalid_format',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'an unsafe integer',
        limits: rawCap(2 ** 60),
        code: 'too_big',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a null',
        limits: rawCap(null),
        code: 'invalid_union',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a raw cap without a value',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Raw },
        },
        code: 'invalid_union',
        path: `${CAP_PATH}.value`,
      },
      {
        name: 'a value on an unlimited cap',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Unlimited, value: '1000' },
        },
        code: 'unrecognized_keys',
        path: CAP_PATH,
      },
      {
        name: 'an unknown key on a raw cap',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Raw, value: '1000', extra: true },
        },
        code: 'unrecognized_keys',
        path: CAP_PATH,
      },
      {
        name: "a cap given as the string 'unlimited'",
        limits: { type: XERC20Type.Aevo, authorized: true, cap: 'unlimited' },
        code: 'invalid_type',
        path: CAP_PATH,
      },
      {
        name: 'a cap given as a numeric string',
        limits: { type: XERC20Type.Aevo, authorized: true, cap: '1000' },
        code: 'invalid_type',
        path: CAP_PATH,
      },
      {
        name: 'a cap of an unknown type',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: 'infinite' },
        },
        code: 'invalid_union',
        path: `${CAP_PATH}.type`,
      },
      {
        name: 'a cap type that is differently cased',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: 'Unlimited' },
        },
        code: 'invalid_union',
        path: `${CAP_PATH}.type`,
      },
      {
        name: 'a cap without a type',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { value: '1000' },
        },
        code: 'invalid_union',
        path: `${CAP_PATH}.type`,
      },
      {
        name: 'an authorized minter without a cap',
        limits: { type: XERC20Type.Aevo, authorized: true },
        code: 'invalid_type',
        path: CAP_PATH,
      },
      {
        name: 'a raw cap on a minter that is not authorized',
        limits: {
          type: XERC20Type.Aevo,
          authorized: false,
          cap: { type: XERC20AevoCapType.Raw, value: '1000' },
        },
        code: 'unrecognized_keys',
        path: 'xERC20.warpRouteLimits',
      },
      {
        name: 'an unlimited cap on a minter that is not authorized',
        limits: {
          type: XERC20Type.Aevo,
          authorized: false,
          cap: { type: XERC20AevoCapType.Unlimited },
        },
        code: 'unrecognized_keys',
        path: 'xERC20.warpRouteLimits',
      },
      {
        name: 'limits that leave out whether the minter is authorized',
        limits: {
          type: XERC20Type.Aevo,
          cap: { type: XERC20AevoCapType.Unlimited },
        },
        code: 'invalid_union',
        path: 'xERC20.warpRouteLimits.authorized',
      },
      {
        name: 'an authorized that is not a boolean',
        limits: {
          type: XERC20Type.Aevo,
          authorized: 'true',
          cap: { type: XERC20AevoCapType.Unlimited },
        },
        code: 'invalid_union',
        path: 'xERC20.warpRouteLimits.authorized',
      },
    ];

    for (const c of cases) {
      it(`rejects ${c.name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(c.limits),
        );

        expect(result.success).to.equal(false);
        assert(!result.success, 'Expected the Aevo limits to be rejected');
        expect(result.error.issues).to.have.lengthOf(1);
        const [issue] = result.error.issues;
        expect(issue.code).to.equal(c.code);
        expect(issue.path.join('.')).to.equal(c.path);
      });
    }

    // Which other contracts may mint an Aevo token is not modelled, so Aevo
    // limits belong to the router and an entry of extraBridges cannot hold
    // them, whatever it declares.
    interface ExtraBridgeCase {
      name: string;
      limits: object;
    }

    const extraBridgeCases: ExtraBridgeCase[] = [
      {
        name: 'a minter that is not authorized',
        limits: { type: XERC20Type.Aevo, authorized: false },
      },
      {
        name: 'an authorized minter with a raw cap',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Raw, value: '1000' },
        },
      },
      {
        name: 'an authorized minter without a bound',
        limits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Unlimited },
        },
      },
    ];

    // Over a Standard route, which rejects nothing else about them.
    for (const c of extraBridgeCases) {
      it(`rejects ${c.name} as an extra bridge`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(STANDARD_LIMITS, [
            { lockbox: SOME_ADDRESS, limits: c.limits },
          ]),
        );

        expect(result.success).to.equal(false);
        assert(!result.success, 'Expected the Aevo limits to be rejected');
        expect(result.error.issues.map((issue) => issue.message)).to.deep.equal(
          [EXTRA_BRIDGE_MESSAGE],
        );
        expect(result.error.issues[0].path.join('.')).to.equal(
          'xERC20.extraBridges.0.limits',
        );
      });
    }

    it('names the index of the Aevo extra bridge among valid ones', () => {
      const result = XERC20TokenConfigSchema.safeParse(
        xERC20Config(STANDARD_LIMITS, [
          { lockbox: SOME_ADDRESS, limits: STANDARD_LIMITS },
          {
            lockbox: SOME_ADDRESS,
            limits: { type: XERC20Type.Aevo, authorized: false },
          },
        ]),
      );

      expect(result.success).to.equal(false);
      assert(!result.success, 'Expected the Aevo limits to be rejected');
      expect(
        result.error.issues.map((issue) => issue.path.join('.')),
      ).to.deep.equal(['xERC20.extraBridges.1.limits']);
    });

    interface RouterOnlyCase {
      name: string;
      warpRouteLimits: object;
      extraBridgeLimits: object;
      messages: string[];
    }

    const routerOnlyCases: RouterOnlyCase[] = [
      {
        name: 'a Standard extra bridge',
        warpRouteLimits: { type: XERC20Type.Aevo, authorized: false },
        extraBridgeLimits: STANDARD_LIMITS,
        messages: [ROUTER_ONLY_MESSAGE],
      },
      {
        name: 'a Velodrome extra bridge',
        warpRouteLimits: { type: XERC20Type.Aevo, authorized: false },
        extraBridgeLimits: VELO_LIMITS,
        messages: [ROUTER_ONLY_MESSAGE],
      },
      {
        name: 'a Standard extra bridge, for an authorized router',
        warpRouteLimits: {
          type: XERC20Type.Aevo,
          authorized: true,
          cap: { type: XERC20AevoCapType.Raw, value: '1000' },
        },
        extraBridgeLimits: STANDARD_LIMITS,
        messages: [ROUTER_ONLY_MESSAGE],
      },
      {
        name: 'an Aevo extra bridge, which is turned away as well',
        warpRouteLimits: { type: XERC20Type.Aevo, authorized: false },
        extraBridgeLimits: { type: XERC20Type.Aevo, authorized: false },
        messages: [EXTRA_BRIDGE_MESSAGE, ROUTER_ONLY_MESSAGE],
      },
    ];

    for (const c of routerOnlyCases) {
      it(`rejects Aevo limits with ${c.name}`, () => {
        const result = XERC20TokenConfigSchema.safeParse(
          xERC20Config(c.warpRouteLimits, [
            { lockbox: SOME_ADDRESS, limits: c.extraBridgeLimits },
          ]),
        );

        expect(result.success).to.equal(false);
        assert(!result.success, 'Expected the extra bridge to be rejected');
        expect(
          result.error.issues.map((issue) => issue.message),
        ).to.have.members(c.messages);
        expect(
          result.error.issues
            .filter((issue) => issue.message === ROUTER_ONLY_MESSAGE)
            .map((issue) => issue.path.join('.')),
        ).to.deep.equal(['xERC20.extraBridges']);
      });
    }
  });
});
