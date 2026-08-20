import { expect } from 'chai';
import { constants, providers, utils } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import {
  DEFAULT_ROUTER_KEY,
  ResolvedRoutingFeeConfigInput,
  TokenFeeType,
} from '../fee/types.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { test1, test2 } from '../consts/testChains.js';
import type { WarpCoreConfig } from '../warp/types.js';

import { TokenType } from './config.js';
import {
  canonicalizeAllowedRebalancingBridges,
  canonicalizeDomainKeyedMap,
  completeHybridHookNodesFromIsm,
  expandWarpDeployConfig,
  mergeRebalanceTargets,
  filterWarpCoreConfigMapByChains,
  getDefaultRemoteRouterAndDestinationGasConfig,
  getChainsFromWarpCoreConfig,
  normalizeWarpDeployConfigForCheck,
  resolveTokenFeeAddress,
  transformConfigToCheck,
  warpCoreConfigMatchesChains,
} from './configUtils.js';
import { TokenStandard } from './TokenStandard.js';
import {
  HypTokenConfig,
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
} from './types.js';

function buildMultiProvider(): MultiProvider {
  return new MultiProvider({
    [test1.name]: test1,
    [test2.name]: test2,
  });
}

describe('configUtils', () => {
  describe(getDefaultRemoteRouterAndDestinationGasConfig.name, () => {
    it('excludes atomic local bridge foreign deployments', () => {
      const address = '0x1111111111111111111111111111111111111111';
      const deployConfig: WarpRouteDeployConfig = {
        [test1.name]: {
          owner: address,
          type: TokenType.synthetic,
        },
        [test2.name]: {
          foreignDeployment: address,
          owner: address,
          sourceRouter: address,
          type: TokenType.atomicLocalRebalancing,
        },
      };

      const [remoteRouters, destinationGas] =
        getDefaultRemoteRouterAndDestinationGasConfig(
          buildMultiProvider(),
          test1.name,
          { [test1.name]: address },
          deployConfig,
        );

      expect(remoteRouters).to.deep.equal({});
      expect(destinationGas).to.deep.equal({});
    });
  });

  describe(completeHybridHookNodesFromIsm.name, () => {
    it('completes an explicit delayed-flow hook leaf from the ISM leaf', () => {
      const owner = '0x1111111111111111111111111111111111111111';
      const warpRouter = '0x2222222222222222222222222222222222222222';
      const remoteIsm = utils.hexZeroPad(
        '0x3333333333333333333333333333333333333333',
        32,
      );
      const hook = {
        type: HookType.AGGREGATION,
        hooks: [
          {
            type: HookType.DELAYED_FLOW_ROUTER,
            thresholdBps: 10000,
            maxDelay: 5,
            duration: 86400n,
            owner,
          },
        ],
      };
      const ism = {
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [
          {
            type: IsmType.DELAYED_FLOW_ROUTER,
            warpRouter,
            thresholdBps: 10000,
            maxDelay: 5,
            duration: 86400n,
            owner,
            remoteIsms: { [test2.name]: remoteIsm },
          },
        ],
      };

      expect(completeHybridHookNodesFromIsm(hook, ism)).to.deep.equal({
        ...hook,
        hooks: [ism.modules[0]],
      });
    });
  });

  describe(expandWarpDeployConfig.name, () => {
    it('rejects a hybrid config without a deployed router address', async () => {
      const owner = '0x1111111111111111111111111111111111111111';
      let thrown: unknown;

      try {
        await expandWarpDeployConfig({
          multiProvider: buildMultiProvider(),
          warpDeployConfig: {
            [test1.name]: {
              type: TokenType.synthetic,
              name: 'Test',
              symbol: 'TEST',
              decimals: 18,
              owner,
              mailbox: '0x2222222222222222222222222222222222222222',
              interchainSecurityModule: {
                type: IsmType.DELAYED_FLOW_ROUTER,
                thresholdBps: 10000,
                maxDelay: 60,
                duration: 86400n,
                owner,
              },
            },
          },
          deployedRoutersAddresses: {},
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(Error);
      assert(thrown instanceof Error, 'Expected expansion to fail');
      expect(thrown.message).to.equal(
        `Missing deployed router address for ${test1.name}, which declares a hybrid hook/ISM`,
      );
    });

    it('defaults an omitted hook to the completed hybrid ISM node', async () => {
      const owner = '0x1111111111111111111111111111111111111111';
      const router = '0x2222222222222222222222222222222222222222';
      const multiProvider = buildMultiProvider();
      const provider = multiProvider.getProvider(test1.name);
      const getCodeStub = sinon.stub(provider, 'getCode').resolves('0x01');
      const getStorageAtStub = sinon
        .stub(provider, 'getStorageAt')
        .resolves('0x0');

      try {
        const expanded = await expandWarpDeployConfig({
          multiProvider,
          warpDeployConfig: {
            [test1.name]: {
              type: TokenType.synthetic,
              name: 'Test',
              symbol: 'TEST',
              decimals: 18,
              owner,
              mailbox: '0x3333333333333333333333333333333333333333',
              interchainSecurityModule: {
                type: IsmType.AGGREGATION,
                threshold: 2,
                modules: [
                  { type: IsmType.TRUSTED_RELAYER, relayer: owner },
                  {
                    type: IsmType.DELAYED_FLOW_ROUTER,
                    thresholdBps: 10000,
                    maxDelay: 60,
                    duration: 86400n,
                    owner,
                  },
                ],
              },
            },
          },
          deployedRoutersAddresses: { [test1.name]: router },
        });

        expect(expanded[test1.name].hook).to.deep.equal({
          type: IsmType.DELAYED_FLOW_ROUTER,
          warpRouter: router,
          thresholdBps: 10000,
          maxDelay: 60,
          duration: 86400n,
          owner,
          remoteIsms: undefined,
        });
      } finally {
        getCodeStub.restore();
        getStorageAtStub.restore();
      }
    });
  });

  describe(transformConfigToCheck.name, () => {
    const ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

    const testCases: Array<{
      msg: string;
      expected: any;
      input: any;
    }> = [
      {
        msg: 'It should remove the address and ownerOverrides fields from the config',
        input: {
          ownerOverrides: {
            owner: ADDRESS,
          },
          hook: {
            type: HookType.AMOUNT_ROUTING,
            address: ADDRESS,
          },
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            address: ADDRESS,
            modules: [
              {
                type: IsmType.AMOUNT_ROUTING,
                address: ADDRESS,
              },
              {
                type: IsmType.FALLBACK_ROUTING,
                address: ADDRESS,
              },
            ],
          },
        },
        expected: {
          hook: {
            type: HookType.AMOUNT_ROUTING,
          },
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            modules: [
              {
                type: IsmType.AMOUNT_ROUTING,
              },
              {
                type: IsmType.FALLBACK_ROUTING,
              },
            ],
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should not remove the address property from the remoteRouters object',
        input: {
          interchainSecurityModule: {
            address: ADDRESS,
            type: 'NULL',
          },
          remoteRouters: {
            '1': {
              address: ADDRESS,
            },
          },
        },
        expected: {
          interchainSecurityModule: {
            type: 'NULL',
          },
          remoteRouters: {
            '1': {
              address: ADDRESS,
            },
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should preserve the proxyAdmin address property for explicit checks',
        input: {
          hook: {
            address: ADDRESS,
            type: HookType.MERKLE_TREE,
          },
          proxyAdmin: {
            address: ADDRESS,
            owner: ADDRESS,
          },
        },
        expected: {
          hook: {
            type: HookType.MERKLE_TREE,
          },
          proxyAdmin: {
            address: ADDRESS,
            owner: ADDRESS,
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should sort out of order modules and validator arrays',
        expected: {
          bsc: {
            decimals: 6,
            interchainSecurityModule: {
              type: 'defaultFallbackRoutingIsm',
              owner: '0xe472f601aeeebeafbbd3a6fd9a788966011ad1df',
              domains: {
                milkyway: {
                  threshold: '1',
                  modules: [
                    {
                      threshold: 3,
                      type: 'merkleRootMultisigIsm',
                      validators: [
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                    {
                      threshold: 3,
                      type: 'messageIdMultisigIsm',
                      validators: [
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                  ],
                },
              },
            },
            name: 'MilkyWay',
            owner: '0xe472f601aeeebeafbbd3a6fd9a788966011ad1df',
            symbol: 'MILK',
            type: 'synthetic',
          },
          milkyway: {
            foreignDeployment:
              '0x726f757465725f61707000000000000000000000000000010000000000000000',
            owner: 'milk169dcaz397j75tjfpl6ykm23dfrv39dqd58lsag',
            type: 'native',
          },
          scale: { numerator: 1n, denominator: 1n },
        },
        input: {
          bsc: {
            decimals: 6,
            interchainSecurityModule: {
              type: 'defaultFallbackRoutingIsm',
              owner: '0xE472F601aeEeBEafbbd3a6FD9A788966011AD1Df',
              domains: {
                milkyway: {
                  threshold: '1',
                  modules: [
                    {
                      threshold: 3,
                      type: 'messageIdMultisigIsm',
                      validators: [
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                    {
                      threshold: 3,
                      type: 'merkleRootMultisigIsm',
                      validators: [
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                  ],
                },
              },
            },
            name: 'MilkyWay',
            owner: '0xE472F601aeEeBEafbbd3a6FD9A788966011AD1Df',
            symbol: 'MILK',
            type: 'synthetic',
          },
          milkyway: {
            foreignDeployment:
              '0x726f757465725f61707000000000000000000000000000010000000000000000',
            owner: 'milk169dcaz397j75tjfpl6ykm23dfrv39dqd58lsag',
            type: 'native',
          },
        },
      },
    ];

    for (const { msg, input, expected } of testCases) {
      it(msg, () => {
        const transformedObj = transformConfigToCheck(input);

        expect(transformedObj).to.eql(expected);
      });
    }

    it('normalizes plain number scale to {numerator, denominator} bigint', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: 1000000000000,
      } as any);

      expect(transformedObj.scale).to.eql({
        numerator: 1000000000000n,
        denominator: 1n,
      });
    });

    it('normalizes {number, number} scale to {bigint, bigint}', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1, denominator: 1000000000000 },
      } as any);

      expect(transformedObj.scale).to.eql({
        numerator: 1n,
        denominator: 1000000000000n,
      });
    });

    it('normalizes undefined scale to identity {1n, 1n}', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
      } as any);

      expect(transformedObj.scale).to.eql({
        numerator: 1n,
        denominator: 1n,
      });
    });

    it('normalizes LinearFee maxFee/halfAmount so equivalent bps configs compare equal', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          maxFee: 999n,
          halfAmount: 123n,
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
        },
      });
    });

    it('normalizes OffchainQuotedLinearFee maxFee/halfAmount so equivalent bps configs compare equal', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          maxFee: 999n,
          halfAmount: 123n,
          quoteSigners: [ADDRESS],
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          quoteSigners: [ADDRESS],
        },
      });
    });

    it('normalizes RoutingFee maxFee/halfAmount recursively for feeContracts', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          maxFee: 1n,
          halfAmount: 2n,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 300n,
              maxFee: 3n,
              halfAmount: 4n,
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: constants.AddressZero,
              token: ADDRESS,
              bps: 300n,
            },
          },
        },
      });
    });

    it('normalizes CCRF router-keyed fee contracts recursively', () => {
      const ROUTER_KEY =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
                maxFee: 3n,
                halfAmount: 4n,
              },
              [ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 300n,
                maxFee: 5n,
                halfAmount: 6n,
              },
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: constants.AddressZero,
                token: ADDRESS,
                bps: 200n,
              },
              [ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: constants.AddressZero,
                token: ADDRESS,
                bps: 300n,
              },
            },
          },
        },
      });
    });

    it('keeps only populated CCRF router entries during normalization', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
              },
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: constants.AddressZero,
                token: ADDRESS,
                bps: 200n,
              },
            },
          },
        },
      });
    });

    it('normalizes RoutingFee feeContracts when both destination and nested fee contracts are provided', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 100n,
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: constants.AddressZero,
              token: ADDRESS,
              bps: 100n,
            },
          },
        },
      });
    });

    it('ignores nested LinearFee sub-fee owner drift while preserving the top-level owner', () => {
      const OTHER_OWNER = '0x1111111111111111111111111111111111111111';

      const build = (subOwner: string): HypTokenRouterConfig => {
        const tokenFee: ResolvedRoutingFeeConfigInput = {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: subOwner,
              token: ADDRESS,
              bps: 100,
            },
          },
        };
        return transformConfigToCheck({
          type: TokenType.collateral,
          token: ADDRESS,
          mailbox: ADDRESS,
          owner: ADDRESS,
          tokenFee,
        });
      };

      // Two configs that differ ONLY in the nested LinearFee owner normalize equal.
      expect(build(ADDRESS)).to.eql(build(OTHER_OWNER));

      const { tokenFee } = build(OTHER_OWNER);
      assert(
        tokenFee?.type === TokenFeeType.RoutingFee,
        'expected a RoutingFee tokenFee',
      );
      // Top-level RoutingFee owner is still surfaced (not collapsed).
      expect(tokenFee.owner).to.equal(ADDRESS);

      const nested = tokenFee.feeContracts.ethereum;
      assert(
        nested.type === TokenFeeType.LinearFee,
        'expected a LinearFee nested fee',
      );
      // Nested LinearFee owner is collapsed to the sentinel: drift is ignored.
      expect(nested.owner).to.equal(constants.AddressZero);
    });

    it('detects OffchainQuotedLinearFee sub-fee owner drift', () => {
      const OTHER_OWNER = '0x1111111111111111111111111111111111111111';

      const build = (subOwner: string): HypTokenRouterConfig => {
        const tokenFee: ResolvedRoutingFeeConfigInput = {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.OffchainQuotedLinearFee,
              owner: subOwner,
              token: ADDRESS,
              bps: 100,
              quoteSigners: [ADDRESS],
            },
          },
        };
        return transformConfigToCheck({
          type: TokenType.collateral,
          token: ADDRESS,
          mailbox: ADDRESS,
          owner: ADDRESS,
          tokenFee,
        });
      };

      // OQLF owner controls quote signers, so owner-only drift must NOT normalize equal.
      expect(build(ADDRESS)).to.not.eql(build(OTHER_OWNER));

      const { tokenFee } = build(OTHER_OWNER);
      assert(
        tokenFee?.type === TokenFeeType.RoutingFee,
        'expected a RoutingFee tokenFee',
      );
      const nested = tokenFee.feeContracts.ethereum;
      assert(
        nested.type === TokenFeeType.OffchainQuotedLinearFee,
        'expected an OffchainQuotedLinearFee nested fee',
      );
      // Real OQLF owner is preserved (not collapsed to the sentinel).
      expect(nested.owner).to.equal(OTHER_OWNER);
      // Nested quoteSigners are still surfaced.
      expect(nested.quoteSigners).to.eql([ADDRESS]);
    });
  });

  describe(resolveTokenFeeAddress.name, () => {
    const ROUTER_ADDRESS = '0x1234567890123456789012345678901234567890';
    const OWNER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const COLLATERAL_TOKEN = '0x9999999999999999999999999999999999999999';
    // xERC20 fee token is read from the router's on-chain wrappedToken(), which
    // is distinct from tokenConfig.token here so we can prove the on-chain read.
    const XERC20_CONFIG_TOKEN = '0x6666666666666666666666666666666666666666';
    const XERC20_ONCHAIN_TOKEN = '0x5555555555555555555555555555555555555555';
    // The lockbox's on-chain wrappedToken() returns the underlying wrapped
    // ERC20, distinct from the lockbox address stored in tokenConfig.token.
    const LOCKBOX_ADDRESS = '0x8888888888888888888888888888888888888888';
    const LOCKBOX_WRAPPED_TOKEN = '0x7777777777777777777777777777777777777777';

    // Function selectors for the router getters exercised by fee resolution.
    const TOKEN_SELECTOR = utils.id('token()').slice(0, 10);
    const WRAPPED_TOKEN_SELECTOR = utils.id('wrappedToken()').slice(0, 10);

    let sandbox: sinon.SinonSandbox;
    let provider: providers.Provider;

    // Stubs the router's on-chain wrappedToken() view call so xERC20/
    // xERC20Lockbox fee resolution reads the returned address without hitting a
    // live RPC.
    function stubRouterToken(returnedToken: string): void {
      sandbox
        .stub(provider, 'call')
        .resolves(utils.defaultAbiCoder.encode(['address'], [returnedToken]));
    }

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      provider = buildMultiProvider().getProvider(test1.name);
    });

    afterEach(() => {
      sandbox.restore();
    });

    const syntheticConfig: HypTokenConfig = {
      type: TokenType.synthetic,
    };

    const collateralConfig: HypTokenConfig = {
      type: TokenType.collateral,
      token: COLLATERAL_TOKEN,
    };

    const nativeConfig: HypTokenConfig = {
      type: TokenType.native,
    };

    const xerc20Config: HypTokenConfig = {
      type: TokenType.XERC20,
      token: XERC20_CONFIG_TOKEN,
    };

    const xerc20LockboxConfig: HypTokenConfig = {
      type: TokenType.XERC20Lockbox,
      token: LOCKBOX_ADDRESS,
    };

    it('should resolve token to router address for synthetic tokens', async () => {
      const input = {
        type: TokenFeeType.LinearFee,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
        provider,
      );

      assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.owner).to.equal(OWNER_ADDRESS);
    });

    it('should resolve token to collateral address for collateral tokens', async () => {
      const input = {
        type: TokenFeeType.LinearFee,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        collateralConfig,
        provider,
      );

      assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(result.token).to.equal(COLLATERAL_TOKEN);
    });

    it('should resolve token to AddressZero for native tokens', async () => {
      const input = {
        type: TokenFeeType.LinearFee,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        nativeConfig,
        provider,
      );

      assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(result.token).to.equal(constants.AddressZero);
    });

    it('should resolve token to the on-chain wrappedToken() for xERC20 tokens', async () => {
      // The fee token is read from wrappedToken(), not tokenConfig.token.
      stubRouterToken(XERC20_ONCHAIN_TOKEN);

      const input = {
        type: TokenFeeType.LinearFee,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        xerc20Config,
        provider,
      );

      assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(result.token).to.equal(XERC20_ONCHAIN_TOKEN);
      expect(result.token).to.not.equal(XERC20_CONFIG_TOKEN);
    });

    it('should resolve token to the on-chain wrapped token for xERC20Lockbox tokens', async () => {
      // For a lockbox, the fee token must match the router's wrappedToken()
      // (the underlying wrapped ERC20), NOT the lockbox address in the config.
      stubRouterToken(LOCKBOX_WRAPPED_TOKEN);

      const input = {
        type: TokenFeeType.LinearFee,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        xerc20LockboxConfig,
        provider,
      );

      assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(result.token).to.equal(LOCKBOX_WRAPPED_TOKEN);
      expect(result.token).to.not.equal(LOCKBOX_ADDRESS);
    });

    // Regression: legacy routers (e.g. 6.1.0) do not override token(), so it
    // reverts. Fee resolution runs at plan time BEFORE the router is upgraded,
    // so a single warp apply that both upgrades the contract and adds a fee
    // would fail if it read token(). It must read the immutable wrappedToken(),
    // which is present and non-reverting across router versions.
    for (const { name, config, wrappedToken } of [
      {
        name: 'xERC20',
        config: xerc20Config,
        wrappedToken: XERC20_ONCHAIN_TOKEN,
      },
      {
        name: 'xERC20Lockbox',
        config: xerc20LockboxConfig,
        wrappedToken: LOCKBOX_WRAPPED_TOKEN,
      },
    ]) {
      it(`resolves the fee token via wrappedToken() when a legacy router's token() reverts for ${name}`, async () => {
        sandbox
          .stub(provider, 'call')
          .callsFake(
            async (
              transaction: utils.Deferrable<providers.TransactionRequest>,
            ) => {
              const data = utils.hexlify((await transaction.data) ?? '0x');
              if (data.startsWith(TOKEN_SELECTOR)) {
                // Mirror the legacy 6.1.0 router: token() reverts.
                throw new Error('call revert exception: token()');
              }
              if (data.startsWith(WRAPPED_TOKEN_SELECTOR)) {
                return utils.defaultAbiCoder.encode(
                  ['address'],
                  [wrappedToken],
                );
              }
              throw new Error(`unexpected call to router: ${data}`);
            },
          );

        const result = await resolveTokenFeeAddress(
          { type: TokenFeeType.LinearFee, owner: OWNER_ADDRESS, bps: 100 },
          ROUTER_ADDRESS,
          config,
          provider,
        );

        assert(result.type === TokenFeeType.LinearFee, 'expected a LinearFee');
        expect(result.token).to.equal(wrappedToken);
      });
    }

    it('should resolve nested feeContracts tokens for RoutingFee', async () => {
      const input = {
        type: TokenFeeType.RoutingFee,
        owner: OWNER_ADDRESS,
        feeContracts: {
          ethereum: {
            type: TokenFeeType.LinearFee,
            owner: OWNER_ADDRESS,
            bps: 100,
          },
          arbitrum: {
            type: TokenFeeType.LinearFee,
            owner: OWNER_ADDRESS,
            bps: 50,
          },
        },
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
        provider,
      );

      assert(result.type === TokenFeeType.RoutingFee, 'expected a RoutingFee');
      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.feeContracts.ethereum.token).to.equal(ROUTER_ADDRESS);
      expect(result.feeContracts.arbitrum.token).to.equal(ROUTER_ADDRESS);
    });

    it('should handle RoutingFee with empty feeContracts', async () => {
      const input = {
        type: TokenFeeType.RoutingFee,
        owner: OWNER_ADDRESS,
        feeContracts: {},
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
        provider,
      );

      assert(result.type === TokenFeeType.RoutingFee, 'expected a RoutingFee');
      expect(result.token).to.equal(ROUTER_ADDRESS);
    });

    it('should resolve token for nested cross collateral feeContracts', async () => {
      const ROUTER_KEY =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const input = {
        type: TokenFeeType.CrossCollateralRoutingFee,
        owner: OWNER_ADDRESS,
        feeContracts: {
          ethereum: {
            [DEFAULT_ROUTER_KEY]: {
              type: TokenFeeType.LinearFee,
              owner: OWNER_ADDRESS,
              bps: 100n,
            },
            [ROUTER_KEY]: {
              type: TokenFeeType.LinearFee,
              owner: OWNER_ADDRESS,
              bps: 200n,
            },
          },
        },
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
        provider,
      );

      assert(
        result.type === TokenFeeType.CrossCollateralRoutingFee,
        'expected a CrossCollateralRoutingFee',
      );
      expect(result.feeContracts.ethereum[DEFAULT_ROUTER_KEY]?.token).to.equal(
        ROUTER_ADDRESS,
      );
      expect(result.feeContracts.ethereum[ROUTER_KEY]?.token).to.equal(
        ROUTER_ADDRESS,
      );
    });

    it('reads the on-chain token() only once for nested RoutingFee', async () => {
      const callStub = sandbox
        .stub(provider, 'call')
        .resolves(
          utils.defaultAbiCoder.encode(['address'], [XERC20_ONCHAIN_TOKEN]),
        );

      const input = {
        type: TokenFeeType.RoutingFee,
        owner: OWNER_ADDRESS,
        feeContracts: {
          ethereum: {
            type: TokenFeeType.LinearFee,
            owner: OWNER_ADDRESS,
            bps: 100,
          },
          arbitrum: {
            type: TokenFeeType.LinearFee,
            owner: OWNER_ADDRESS,
            bps: 50,
          },
        },
      };

      const result = await resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        xerc20Config,
        provider,
      );

      assert(result.type === TokenFeeType.RoutingFee, 'expected a RoutingFee');
      // Same feeToken threaded through every nesting level.
      expect(result.token).to.equal(XERC20_ONCHAIN_TOKEN);
      expect(result.feeContracts.ethereum.token).to.equal(XERC20_ONCHAIN_TOKEN);
      expect(result.feeContracts.arbitrum.token).to.equal(XERC20_ONCHAIN_TOKEN);
      // token() resolved a single time despite the nested fee contracts.
      expect(callStub.callCount).to.equal(1);
    });
  });

  describe(normalizeWarpDeployConfigForCheck.name, () => {
    const ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    const OTHER_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    it('normalizes OFT configs to sentinel router state for checks', () => {
      const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
        [test1.name]: {
          decimals: 6,
          destinationGas: { [test2.name]: '12345' },
          domainMappings: { [test2.name]: 30110 },
          extraOptions: '0x',
          hook: OTHER_ADDRESS,
          interchainSecurityModule: OTHER_ADDRESS,
          mailbox: ADDRESS,
          name: 'USDT',
          oft: OTHER_ADDRESS,
          owner: ADDRESS,
          remoteRouters: {
            [test2.name]: {
              address: OTHER_ADDRESS,
            },
          },
          symbol: 'USDT',
          token: ADDRESS,
          type: TokenType.collateralOft,
        },
      };

      const normalized = normalizeWarpDeployConfigForCheck({
        multiProvider: buildMultiProvider(),
        warpDeployConfig,
      });

      expect(normalized[test1.name]).to.deep.equal({
        decimals: 6,
        destinationGas: undefined,
        domainMappings: { [test2.domainId]: 30110 },
        extraOptions: undefined,
        hook: constants.AddressZero,
        interchainSecurityModule: constants.AddressZero,
        mailbox: constants.AddressZero,
        name: 'USDT',
        oft: OTHER_ADDRESS,
        owner: ADDRESS,
        remoteRouters: {},
        symbol: 'USDT',
        token: ADDRESS,
        type: TokenType.collateralOft,
      });
    });

    it('preserves non-empty OFT extraOptions', () => {
      const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
        [test1.name]: {
          decimals: 6,
          domainMappings: { [test2.name]: 30110 },
          extraOptions: '0xdeadbeef',
          hook: OTHER_ADDRESS,
          interchainSecurityModule: OTHER_ADDRESS,
          mailbox: ADDRESS,
          name: 'USDT',
          oft: OTHER_ADDRESS,
          owner: ADDRESS,
          symbol: 'USDT',
          token: ADDRESS,
          type: TokenType.collateralOft,
        },
      };

      const normalized = normalizeWarpDeployConfigForCheck({
        multiProvider: buildMultiProvider(),
        warpDeployConfig,
      });

      expect(normalized[test1.name]).to.deep.include({
        extraOptions: '0xdeadbeef',
      });
    });

    it('leaves non-OFT configs unchanged', () => {
      const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
        [test1.name]: {
          decimals: 18,
          mailbox: ADDRESS,
          name: 'TOKEN',
          owner: ADDRESS,
          symbol: 'TKN',
          type: TokenType.synthetic,
        },
      };

      const normalized = normalizeWarpDeployConfigForCheck({
        multiProvider: buildMultiProvider(),
        warpDeployConfig,
      });

      expect(normalized).to.deep.equal(warpDeployConfig);
    });
  });

  const buildWarpCoreConfig = (chainNames: string[]): WarpCoreConfig => ({
    tokens: chainNames.map((chainName, index) => ({
      chainName,
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: `TKN${index + 1}`,
      name: `Token ${index + 1}`,
      addressOrDenom: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    })),
  });

  describe('getChainsFromWarpCoreConfig', () => {
    it('should return chain names from tokens', () => {
      const config = buildWarpCoreConfig(['ethereum', 'arbitrum', 'optimism']);

      const result = getChainsFromWarpCoreConfig(config);
      expect(result).to.deep.equal(['ethereum', 'arbitrum', 'optimism']);
    });

    it('should return empty array for empty tokens', () => {
      const config = buildWarpCoreConfig([]);
      const result = getChainsFromWarpCoreConfig(config);
      expect(result).to.deep.equal([]);
    });
  });

  describe('warpCoreConfigMatchesChains', () => {
    const config = buildWarpCoreConfig(['ethereum', 'arbitrum', 'optimism']);

    it('should return true when all chains are present', () => {
      expect(warpCoreConfigMatchesChains(config, ['ethereum', 'arbitrum'])).to
        .be.true;
    });

    it('should return true for single chain match', () => {
      expect(warpCoreConfigMatchesChains(config, ['optimism'])).to.be.true;
    });

    it('should return false when a chain is missing', () => {
      expect(warpCoreConfigMatchesChains(config, ['ethereum', 'polygon'])).to.be
        .false;
    });

    it('should return true for empty chains array', () => {
      expect(warpCoreConfigMatchesChains(config, [])).to.be.true;
    });
  });

  describe('filterWarpCoreConfigMapByChains', () => {
    const configMap: Record<string, WarpCoreConfig> = {
      'ETH/ethereum-arbitrum': buildWarpCoreConfig(['ethereum', 'arbitrum']),
      'ETH/ethereum-optimism': buildWarpCoreConfig(['ethereum', 'optimism']),
      'USDC/arbitrum-optimism': buildWarpCoreConfig(['arbitrum', 'optimism']),
    };

    it('should filter to routes containing all specified chains', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, [
        'ethereum',
        'arbitrum',
      ]);
      expect(Object.keys(result)).to.deep.equal(['ETH/ethereum-arbitrum']);
    });

    it('should return multiple routes when chains match multiple', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, ['ethereum']);
      expect(Object.keys(result).sort()).to.deep.equal([
        'ETH/ethereum-arbitrum',
        'ETH/ethereum-optimism',
      ]);
    });

    it('should return empty object when no routes match', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, ['polygon']);
      expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it('should return all routes for empty chains array', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, []);
      expect(Object.keys(result)).to.have.lengthOf(3);
    });
  });

  describe(canonicalizeAllowedRebalancingBridges.name, () => {
    const BRIDGE_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const BRIDGE_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const TOKEN_X = '0x1111111111111111111111111111111111111111';
    const TOKEN_Y = '0x2222222222222222222222222222222222222222';
    const TEST1_DOMAIN = test1.domainId.toString();

    // Only test1 resolves; everything else is treated as unknown.
    const resolveDomainId = (key: string): number | undefined =>
      key === test1.name ? test1.domainId : undefined;

    it('canonicalizes chain-name keys to domain ids', () => {
      const result = canonicalizeAllowedRebalancingBridges(
        { [test1.name]: [{ bridge: BRIDGE_A }] },
        resolveDomainId,
      );
      expect(result).to.deep.equal({ [TEST1_DOMAIN]: [{ bridge: BRIDGE_A }] });
    });

    it('merges an identical bridge keyed by both chain name and domain id into one entry', () => {
      const result = canonicalizeAllowedRebalancingBridges(
        {
          [test1.name]: [{ bridge: BRIDGE_A }],
          [TEST1_DOMAIN]: [{ bridge: BRIDGE_A }],
        },
        resolveDomainId,
      );
      expect(result).to.deep.equal({ [TEST1_DOMAIN]: [{ bridge: BRIDGE_A }] });
    });

    it('deduplicates an identical bridge whose addresses differ only in case', () => {
      const bridgeMixedCase = '0x' + BRIDGE_A.slice(2).toUpperCase();
      const result = canonicalizeAllowedRebalancingBridges(
        {
          [test1.name]: [{ bridge: BRIDGE_A }],
          [TEST1_DOMAIN]: [{ bridge: bridgeMixedCase }],
        },
        resolveDomainId,
      );
      expect(result[TEST1_DOMAIN]).to.have.lengthOf(1);
    });

    it('unions approvedTokens when merging an identical bridge across collided keys', () => {
      const result = canonicalizeAllowedRebalancingBridges(
        {
          [test1.name]: [{ bridge: BRIDGE_A, approvedTokens: [TOKEN_X] }],
          [TEST1_DOMAIN]: [{ bridge: BRIDGE_A, approvedTokens: [TOKEN_Y] }],
        },
        resolveDomainId,
      );
      expect(result[TEST1_DOMAIN]).to.have.lengthOf(1);
      expect(result[TEST1_DOMAIN][0].bridge).to.equal(BRIDGE_A);
      expect(result[TEST1_DOMAIN][0].approvedTokens).to.have.deep.members([
        TOKEN_X,
        TOKEN_Y,
      ]);
    });

    it('keeps distinct bridges under one key when chain name and domain id collide', () => {
      const result = canonicalizeAllowedRebalancingBridges(
        {
          [test1.name]: [{ bridge: BRIDGE_A }],
          [TEST1_DOMAIN]: [{ bridge: BRIDGE_B }],
        },
        resolveDomainId,
      );
      expect(result[TEST1_DOMAIN]).to.have.deep.members([
        { bridge: BRIDGE_A },
        { bridge: BRIDGE_B },
      ]);
    });

    it('preserves keys the resolver does not recognize', () => {
      const result = canonicalizeAllowedRebalancingBridges(
        { unknownchain: [{ bridge: BRIDGE_A }] },
        resolveDomainId,
      );
      expect(result).to.deep.equal({ unknownchain: [{ bridge: BRIDGE_A }] });
    });
  });

  describe(canonicalizeDomainKeyedMap.name, () => {
    const TARGET_A = '0x1111111111111111111111111111111111111111';
    const TARGET_B = '0x2222222222222222222222222222222222222222';
    const TEST1_DOMAIN = test1.domainId.toString();

    // Only test1 resolves; everything else is treated as unknown.
    const resolveDomainId = (key: string): number | undefined =>
      key === test1.name ? test1.domainId : undefined;

    it('canonicalizes chain-name keys to domain ids for rebalanceTargets', () => {
      const result = canonicalizeDomainKeyedMap(
        { [test1.name]: [TARGET_A] },
        resolveDomainId,
        mergeRebalanceTargets,
      );
      expect(result).to.deep.equal({ [TEST1_DOMAIN]: [TARGET_A] });
    });

    it('unions targets when chain name and domain id collapse to one key', () => {
      const result = canonicalizeDomainKeyedMap(
        { [test1.name]: [TARGET_A], [TEST1_DOMAIN]: [TARGET_B] },
        resolveDomainId,
        mergeRebalanceTargets,
      );
      expect(result[TEST1_DOMAIN]).to.have.deep.members([TARGET_A, TARGET_B]);
    });

    it('deduplicates a target keyed by both chain name and domain id', () => {
      const targetMixedCase = '0x' + TARGET_A.slice(2).toUpperCase();
      const result = canonicalizeDomainKeyedMap(
        { [test1.name]: [TARGET_A], [TEST1_DOMAIN]: [targetMixedCase] },
        resolveDomainId,
        mergeRebalanceTargets,
      );
      expect(result[TEST1_DOMAIN]).to.have.lengthOf(1);
    });

    it('canonicalizes rebalanceRecipients with a last-write merge', () => {
      const result = canonicalizeDomainKeyedMap<string>(
        { [test1.name]: TARGET_A },
        resolveDomainId,
        (_existing, incoming) => incoming,
      );
      expect(result).to.deep.equal({ [TEST1_DOMAIN]: TARGET_A });
    });

    it('preserves keys the resolver does not recognize', () => {
      const result = canonicalizeDomainKeyedMap(
        { unknownchain: [TARGET_A] },
        resolveDomainId,
        mergeRebalanceTargets,
      );
      expect(result).to.deep.equal({ unknownchain: [TARGET_A] });
    });
  });
});
