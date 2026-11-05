import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { z } from 'zod';

import { writeYamlOrJson } from '@hyperlane-xyz/utils/fs';

import { RebalancerConfig } from './RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExecutionType,
  ExternalBridgeType,
  PendingTransferMiddlewareType,
  type RebalancerConfigFileInput,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  TokenBridgeStatusAdapterType,
  TokenBridgeStatusAdapterConfigSchema,
  type StrategyConfig,
  StrategyConfigSchema,
  SwapsXyzBridgeConfigSchema,
  getAllBridges,
} from './types.js';

const TEST_CONFIG_PATH = join(tmpdir(), 'rebalancer-config-test.yaml');

describe('strict strategy controls', () => {
  for (const { rebalanceStrategy, chain } of [
    {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chain: { weighted: { weight: 1, tolerance: 0 } },
    },
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chain: {
        minAmount: {
          min: 1,
          target: 2,
          type: RebalancerMinAmountType.Absolute,
        },
      },
    },
    {
      rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
      chain: { buffer: 1 },
    },
  ]) {
    it(`rejects unknown controls in ${rebalanceStrategy} chains and overrides`, () => {
      for (const typo of ['enable', 'unknownControl']) {
        for (const invalid of [
          { ...chain, [typo]: false },
          { ...chain, override: { destination: { [typo]: false } } },
        ]) {
          const result = StrategyConfigSchema.safeParse({
            rebalanceStrategy,
            chains: { origin: invalid },
          });
          expect(result.success).to.equal(false);
          if (!result.success)
            expect(result.error.issues[0].path).to.include('origin');
        }
      }
      const result = StrategyConfigSchema.parse({
        rebalanceStrategy,
        chains: {
          origin: {
            ...chain,
            enabled: true,
            override: { destination: { enabled: false } },
          },
        },
      });
      expect(result.chains.origin.override?.destination.enabled).to.equal(
        false,
      );
    });
  }
});

// Helper to get strategy as array (for test type safety)
// Schema accepts both single object and array, but tests use array format
function getStrategyArray(
  data: RebalancerConfigFileInput,
): z.input<typeof import('./types.js').StrategyConfigSchema>[] {
  return Array.isArray(data.strategy) ? data.strategy : [data.strategy];
}

describe('RebalancerConfig', () => {
  let data: RebalancerConfigFileInput;

  beforeEach(() => {
    data = {
      warpRouteId: 'warpRouteId',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            chain1: {
              weighted: {
                weight: 100,
                tolerance: 0,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            chain2: {
              weighted: {
                weight: 100,
                tolerance: 0,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
        },
      ],
    };

    writeYamlOrJson(TEST_CONFIG_PATH, data);
  });

  afterEach(() => {
    rmSync(TEST_CONFIG_PATH, { force: true });
  });

  it('should throw when the config file does not exist', () => {
    rmSync(TEST_CONFIG_PATH, { force: true });

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      `File doesn't exist at ${TEST_CONFIG_PATH}`,
    );
  });

  it('should load config from file', () => {
    expect(RebalancerConfig.load(TEST_CONFIG_PATH)).to.deep.equal({
      warpRouteId: 'warpRouteId',
      strategyConfig: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            chain1: {
              weighted: {
                weight: 100n,
                tolerance: 0n,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1_000,
            },
            chain2: {
              weighted: {
                weight: 100n,
                tolerance: 0n,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1_000,
            },
          },
        },
      ],
      intentTTL: DEFAULT_INTENT_TTL_MS,
      inventorySigners: undefined,
      externalBridges: undefined,
      pendingTransferMiddlewares: undefined,
    });
  });

  it('should load LayerZero settlement adapters on chains and overrides', () => {
    const strategy = getStrategyArray(data)[0];
    strategy.chains.chain1.statusAdapter = {
      kind: TokenBridgeStatusAdapterType.LayerZeroScan,
      sourceEid: 30110,
      destinationEid: 30420,
      sourceOft: '0x1111111111111111111111111111111111111111',
      destinationOft: '0x2222222222222222222222222222222222222222',
      destinationRecipient: '0x3333333333333333333333333333333333333333',
    };
    strategy.chains.chain1.override = {
      chain2: {
        statusAdapter: {
          kind: TokenBridgeStatusAdapterType.LayerZeroScan,
          sourceEid: 30110,
          destinationEid: 30420,
          sourceOft: '0x1111111111111111111111111111111111111111',
          destinationOft: '0x2222222222222222222222222222222222222222',
        },
      },
    };
    writeYamlOrJson(TEST_CONFIG_PATH, data);

    const chainConfig =
      RebalancerConfig.load(TEST_CONFIG_PATH).strategyConfig[0].chains.chain1;
    expect(chainConfig.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
    expect(
      chainConfig.statusAdapter?.kind ===
        TokenBridgeStatusAdapterType.LayerZeroScan &&
        chainConfig.statusAdapter.destinationRecipient,
    ).to.equal('0x3333333333333333333333333333333333333333');
    expect(chainConfig.override?.chain2.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
  });

  it('rejects wildcard settlement recipients', () => {
    expect(
      TokenBridgeStatusAdapterConfigSchema.safeParse({
        kind: TokenBridgeStatusAdapterType.LayerZeroScan,
        sourceEid: 30101,
        destinationEid: 30110,
        sourceOft: '0x1111111111111111111111111111111111111111',
        destinationOft: '0x2222222222222222222222222222222222222222',
        destinationRecipient: '*',
      }).success,
    ).to.equal(false);
  });

  it('should reject unknown settlement adapter kinds', () => {
    // CAST: This fixture is intentionally invalid to exercise runtime schema validation.
    getStrategyArray(data)[0].chains.chain1.statusAdapter = {
      kind: 'unknown',
    } as any;
    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'Invalid input',
    );
  });

  it('should require LayerZero route identity', () => {
    // CAST: This fixture is intentionally incomplete to exercise runtime schema validation.
    getStrategyArray(data)[0].chains.chain1.statusAdapter = {
      kind: TokenBridgeStatusAdapterType.LayerZeroScan,
    } as any;
    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'Invalid input',
    );
  });

  it('should reject LayerZero EIDs outside uint32', () => {
    getStrategyArray(data)[0].chains.chain1.statusAdapter = {
      kind: TokenBridgeStatusAdapterType.LayerZeroScan,
      sourceEid: 0x1_0000_0000,
      destinationEid: 30420,
      sourceOft: '0x1111111111111111111111111111111111111111',
      destinationOft: '0x2222222222222222222222222222222222222222',
    };
    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'statusAdapter.sourceEid',
    );
  });

  it('should throw if chains are not configured', () => {
    getStrategyArray(data)[0].chains = {};

    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'No chains configured',
    );
  });

  it('should throw if no warp route id is configured', () => {
    // @ts-ignore
    delete data.warpRouteId;

    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'Invalid input: expected string, received undefined',
    );
  });

  it('reports an invalid bridge before running cross-field rules', () => {
    const strategy = getStrategyArray(data)[0];
    strategy.chains.chain1.bridge = 'bridge';
    data.strategy = strategy;
    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
      'Invalid string: must match pattern',
    );
  });

  it('should load relative params without modifications', () => {
    data = {
      warpRouteId: 'warpRouteId',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
          chains: {
            chain1: {
              minAmount: {
                min: '0.2',
                target: 0.3,
                type: RebalancerMinAmountType.Relative,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            chain2: {
              minAmount: {
                min: '0.2',
                target: 0.3,
                type: RebalancerMinAmountType.Relative,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
        },
      ],
    };

    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(
      RebalancerConfig.load(TEST_CONFIG_PATH).strategyConfig[0].chains.chain1,
    ).to.deep.equal({
      ...getStrategyArray(data)[0].chains.chain1,
      bridgeLockTime: 1_000,
    });
  });

  it('should load absolute params without modifications', () => {
    data = {
      warpRouteId: 'warpRouteId',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
          chains: {
            chain1: {
              minAmount: {
                min: '100000',
                target: 140000,
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            chain2: {
              minAmount: {
                min: '100000',
                target: 140000,
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
        },
      ],
    };

    writeYamlOrJson(TEST_CONFIG_PATH, data);

    expect(
      RebalancerConfig.load(TEST_CONFIG_PATH).strategyConfig[0].chains.chain1,
    ).to.deep.equal({
      ...getStrategyArray(data)[0].chains.chain1,
      bridgeLockTime: 1_000,
    });
  });

  describe('override functionality', () => {
    it('should parse a config with overrides', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
            chains: {
              chain1: {
                minAmount: {
                  min: 1000,
                  target: 1100,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
                override: {
                  chain2: {
                    bridge: '0x1234567890123456789012345678901234567890',
                  },
                },
              },
              chain2: {
                minAmount: {
                  min: 2000,
                  target: 2200,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              chain3: {
                minAmount: {
                  min: 3000,
                  target: 3300,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
        ],
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);
      const chainConfig = config.strategyConfig[0].chains.chain1;
      expect(chainConfig).to.have.property('override');

      const override = chainConfig.override;
      expect(override).to.not.be.undefined;
      expect(override).to.have.property('chain2');

      const toChain2Override = override!.chain2;
      expect(toChain2Override).to.have.property('bridge');
      expect(toChain2Override.bridge).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should throw when an override references a non-existent chain', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
            chains: {
              chain1: {
                minAmount: {
                  min: 1000,
                  target: 1100,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
                override: {
                  chain2: {
                    bridge: '0x1234567890123456789012345678901234567890',
                  },
                  chain3: {
                    bridgeMinAcceptedAmount: 1000,
                  },
                },
              },
              chain2: {
                minAmount: {
                  min: 2000,
                  target: 2200,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
        ],
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        "Chain 'chain1' has an override for 'chain3', but 'chain3' is not defined in the config",
      );
    });

    it('should throw when an override references itself', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
            chains: {
              chain1: {
                minAmount: {
                  min: 1000,
                  target: 1100,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
                override: {
                  chain1: {
                    bridgeMinAcceptedAmount: 1000,
                  },
                },
              },
              chain2: {
                minAmount: {
                  min: 2000,
                  target: 2200,
                  type: RebalancerMinAmountType.Absolute,
                },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
        ],
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        "Chain 'chain1' has an override for 'chain1', but 'chain1' is self-referencing",
      );
    });

    it('should allow multiple chain overrides', () => {
      getStrategyArray(data)[0].chains.chain1 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 3000,
        bridgeLockTime: 1,
        weighted: {
          weight: 100,
          tolerance: 0,
        },
        override: {
          chain2: {
            bridgeMinAcceptedAmount: 4000,
          },
          chain3: {
            bridge: '0x1234567890123456789012345678901234567890',
          },
        },
      };

      getStrategyArray(data)[0].chains.chain2 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 5000,
        bridgeLockTime: 1,
        weighted: {
          weight: 100,
          tolerance: 0,
        },
      };

      getStrategyArray(data)[0].chains.chain3 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 6000,
        bridgeLockTime: 1,
        weighted: {
          weight: 100,
          tolerance: 0,
        },
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);
      const chainConfig = config.strategyConfig[0].chains.chain1;
      const chain1Overrides = chainConfig.override;
      expect(chain1Overrides).to.not.be.undefined;
      expect(chain1Overrides).to.have.property('chain2');
      expect(chain1Overrides).to.have.property('chain3');

      const chain2Overrides = chain1Overrides!.chain2;
      expect(chain2Overrides).to.have.property('bridgeMinAcceptedAmount');
      expect(chain2Overrides.bridgeMinAcceptedAmount).to.equal(4000);

      const chain3Overrides = chain1Overrides!.chain3;
      expect(chain3Overrides).to.have.property('bridge');
      expect(chain3Overrides.bridge).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should require externalBridge when override executionType is inventory', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              chain1: {
                weighted: { weight: 60, tolerance: 5 },
                bridge: ethers.constants.AddressZero,
                override: {
                  chain2: {
                    executionType: ExecutionType.Inventory,
                  },
                },
              },
              chain2: {
                weighted: { weight: 40, tolerance: 5 },
                bridge: ethers.constants.AddressZero,
              },
            },
          },
        ],
        inventorySigners: { ethereum: ethers.constants.AddressZero },
        externalBridges: { lifi: { integrator: 'test' } },
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);
      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        /override.*inventory execution.*externalBridge/i,
      );
    });

    it('should require inventorySigners when only override enables inventory execution', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              chain1: {
                weighted: { weight: 60, tolerance: 5 },
                bridge: ethers.constants.AddressZero,
                override: {
                  chain2: {
                    executionType: ExecutionType.Inventory,
                    externalBridge: ExternalBridgeType.LiFi,
                  },
                },
              },
              chain2: {
                weighted: { weight: 40, tolerance: 5 },
                bridge: ethers.constants.AddressZero,
              },
            },
          },
        ],
        externalBridges: { lifi: { integrator: 'test' } },
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);
      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        /inventorySigners.*required/i,
      );
    });
  });

  describe('composite strategy validation', () => {
    it('should throw if CollateralDeficitStrategy is not first in composite', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              chain1: {
                weighted: { weight: 100, tolerance: 0 },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              chain2: {
                weighted: { weight: 100, tolerance: 0 },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
          {
            rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
            chains: {
              chain1: {
                buffer: 1000,
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              chain2: {
                buffer: 1000,
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
        ],
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        'CollateralDeficitStrategy must be first when used in composite strategy',
      );
    });

    it('should allow CollateralDeficitStrategy first in composite', () => {
      data = {
        warpRouteId: 'warpRouteId',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
            chains: {
              chain1: {
                buffer: 1000,
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              chain2: {
                buffer: 1000,
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              chain1: {
                weighted: { weight: 100, tolerance: 0 },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              chain2: {
                weighted: { weight: 100, tolerance: 0 },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
          },
        ],
      };

      writeYamlOrJson(TEST_CONFIG_PATH, data);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.not.throw();
    });
  });
});

describe('Tron inventorySigners validation', () => {
  const TEST_CONFIG_PATH_TRON = join(tmpdir(), 'rebalancer-tron-test.yaml');

  afterEach(() => {
    rmSync(TEST_CONFIG_PATH_TRON, { force: true });
  });

  it('should reject Tron T-prefix base58 address in inventorySigners', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-tron-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            tron: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
            ethereum: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        tron: {
          address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
        ethereum: {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
      },
      externalBridges: {
        lifi: {
          integrator: 'test-app',
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_TRON, data);
    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_TRON)).to.throw(
      /must be a valid 0x hex address/,
    );
  });

  it('should accept valid 0x hex address for Tron inventorySigners', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-tron-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            tron: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
            ethereum: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        tron: {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
        ethereum: {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
      },
      externalBridges: {
        lifi: {
          integrator: 'test-app',
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_TRON, data);
    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_TRON)).to.not.throw();
  });

  it('should reject invalid Tron address in inventorySigners', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-tron-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            tron: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
            ethereum: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        tron: {
          address: 'INVALID_TRON_ADDRESS',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
        ethereum: {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        },
      },
      externalBridges: {
        lifi: {
          integrator: 'test-app',
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_TRON, data);
    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_TRON)).to.throw(
      /must be a valid 0x hex address/,
    );
  });
});

describe('per-chain bridge configuration', () => {
  const TEST_CONFIG_PATH_BRIDGE = join(tmpdir(), 'rebalancer-bridge-test.yaml');

  afterEach(() => {
    rmSync(TEST_CONFIG_PATH_BRIDGE, { force: true });
  });

  it('should accept externalBridge field on chain config when using inventory execution', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
            arbitrum: {
              weighted: { weight: 50, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        lifi: {
          integrator: 'test-app',
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);
    const config = RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE);

    expect(config.strategyConfig[0].chains.ethereum.externalBridge).to.equal(
      'lifi',
    );
    expect(config.externalBridges?.lifi?.integrator).to.equal('test-app');
  });

  it('should accept bridges.lifi section with integrator and optional defaultSlippage', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        lifi: {
          integrator: 'my-app',
          defaultSlippage: 0.01,
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);
    const config = RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE);

    expect(config.externalBridges?.lifi).to.deep.include({
      integrator: 'my-app',
      defaultSlippage: 0.01,
    });
  });

  it('should require externalBridge when executionType is inventory', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /inventory execution.*externalBridge/i,
    );
  });

  it('should accept deBridge inventory execution without LiFi config', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.DeBridge,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        debridge: { maxFeeBps: 50 },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);
    const config = RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE);

    expect(config.externalBridges?.debridge).to.deep.equal({
      maxFeeBps: 50,
    });
  });

  it('should require externalBridges.debridge when selected', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.DeBridge,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /externalBridges\.debridge.*not configured/i,
    );
  });

  it('should accept registry-backed LayerZero inventory execution', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LayerZero,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        layerzero: {
          warpRouteIds: ['USDT/oft', 'USDT/oft-legacy'],
          maxFeeBps: 50,
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);
    const config = RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE);

    expect(config.externalBridges?.layerzero).to.deep.equal({
      warpRouteIds: ['USDT/oft', 'USDT/oft-legacy'],
      maxFeeBps: 50,
    });
  });

  it('should accept swapsxyz inventory config without LiFi config', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.SwapsXyz,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        swapsxyz: {
          apiUrl: 'https://api-v2.swaps.xyz/api',
          defaultSlippage: 0.005,
          maxQuoteLossBps: 50,
          maxSolanaNativeSpendLamports: 10_000_000,
          maxSolanaTransactionFeeLamports: 7_000_000,
          solanaTransactionFeeWarningLamports: 700_000,
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);
    const config = RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE);

    expect(config.externalBridges?.swapsxyz).to.deep.equal({
      apiUrl: 'https://api-v2.swaps.xyz/api',
      defaultSlippage: 0.005,
      maxQuoteLossBps: 50,
      maxSolanaNativeSpendLamports: 10_000_000,
      maxSolanaTransactionFeeLamports: 7_000_000,
      solanaTransactionFeeWarningLamports: 700_000,
    });
    expect(config.externalBridges?.lifi).to.be.undefined;
  });

  it('should require externalBridges.swapsxyz when selected', () => {
    const data: RebalancerConfigFileInput = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.SwapsXyz,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /externalBridges\.swapsxyz.*not configured/i,
    );
  });

  it('accepts default fee policy and independently configured spending budgets', () => {
    expect(SwapsXyzBridgeConfigSchema.safeParse({}).success).to.equal(true);
    expect(
      SwapsXyzBridgeConfigSchema.parse({
        maxSolanaTransactionFeeLamports: 0,
        solanaTransactionFeeWarningLamports: 0,
        maxSolanaNativeSpendLamports: 10_000_000,
      }),
    ).to.include({
      maxSolanaTransactionFeeLamports: 0,
      solanaTransactionFeeWarningLamports: 0,
      maxSolanaNativeSpendLamports: 10_000_000,
    });
  });

  for (const swapsxyz of [
    { apiUrl: 'http://api.swaps.xyz' },
    { defaultSlippage: 50 },
    { maxQuoteLossBps: -1 },
    { maxQuoteLossBps: 10_001 },
    { maxQuoteLossBps: 1.5 },
    { maxTronNativeFeeSun: '-1' },
    { maxSolanaNativeSpendLamports: -1 },
    { maxSolanaNativeSpendLamports: 1.5 },
    { maxSolanaNativeSpendLamports: Number.MAX_SAFE_INTEGER + 1 },
    { maxSolanaTransactionFeeLamports: -1 },
    { maxSolanaTransactionFeeLamports: 1.5 },
    { maxSolanaTransactionFeeLamports: Number.MAX_SAFE_INTEGER + 1 },
    { solanaTransactionFeeWarningLamports: -1 },
    { solanaTransactionFeeWarningLamports: 1.5 },
    { solanaTransactionFeeWarningLamports: Number.MAX_SAFE_INTEGER + 1 },
    { maxSolanaTransactionFeeLamports: 999_999 },
    { solanaTransactionFeeWarningLamports: 10_000_001 },
    {
      maxSolanaTransactionFeeLamports: 2_000_000,
      solanaTransactionFeeWarningLamports: 2_000_001,
    },
  ]) {
    it(`should reject unsafe swapsxyz config ${JSON.stringify(swapsxyz)}`, () => {
      const data: RebalancerConfigFileInput = {
        warpRouteId: 'test-route',
        strategy: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              ethereum: {
                weighted: { weight: 100, tolerance: 5 },
                executionType: ExecutionType.Inventory,
                externalBridge: ExternalBridgeType.SwapsXyz,
              },
            },
          },
        ],
        inventorySigners: {
          ethereum: '0x1234567890123456789012345678901234567890',
        },
        externalBridges: { swapsxyz },
      };

      writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw();
    });
  }

  it('should require externalBridges.lifi when externalBridge is lifi', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
              externalBridge: ExternalBridgeType.LiFi,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /externalBridges\.lifi.*required|lifi.*not configured/i,
    );
  });

  it('should require externalBridge field when executionType is inventory', () => {
    const data = {
      warpRouteId: 'test-route',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 100, tolerance: 5 },
              executionType: ExecutionType.Inventory,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      externalBridges: {
        lifi: {
          integrator: 'test-app',
        },
      },
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /ethereum.*inventory execution.*externalBridge/i,
    );
  });
});

describe('getAllBridges', () => {
  const BRIDGE_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BRIDGE_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const BRIDGE_C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  it('should return empty array for empty strategies', () => {
    const result = getAllBridges([]);
    expect(result).to.deep.equal([]);
  });

  it('should return bridge from single strategy', () => {
    const strategies: StrategyConfig[] = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          chain1: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
          chain2: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
        },
      },
    ];

    const result = getAllBridges(strategies);
    expect(result).to.deep.equal([BRIDGE_A]);
  });

  it('should return all bridges from multiple strategies', () => {
    const strategies: StrategyConfig[] = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
        chains: {
          chain1: {
            buffer: 1000,
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
          chain2: {
            buffer: 1000,
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
        },
      },
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          chain1: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_B,
            bridgeLockTime: 1000,
          },
          chain2: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_B,
            bridgeLockTime: 1000,
          },
        },
      },
    ];

    const result = getAllBridges(strategies);
    expect(result).to.have.members([BRIDGE_A, BRIDGE_B]);
    expect(result).to.have.lengthOf(2);
  });

  it('should include bridges from per-destination overrides', () => {
    const strategies: StrategyConfig[] = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          chain1: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
            override: {
              chain2: {
                bridge: BRIDGE_B,
              },
              chain3: {
                bridge: BRIDGE_C,
              },
            },
          },
          chain2: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
          chain3: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
        },
      },
    ];

    const result = getAllBridges(strategies);
    expect(result).to.have.members([BRIDGE_A, BRIDGE_B, BRIDGE_C]);
    expect(result).to.have.lengthOf(3);
  });

  it('should deduplicate bridges across strategies and overrides', () => {
    const strategies: StrategyConfig[] = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
        chains: {
          chain1: {
            buffer: 1000,
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
          chain2: {
            buffer: 1000,
            bridge: BRIDGE_B,
            bridgeLockTime: 1000,
          },
        },
      },
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          chain1: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A, // Same as first strategy
            bridgeLockTime: 1000,
            override: {
              chain2: {
                bridge: BRIDGE_B, // Same as chain2 default
              },
            },
          },
          chain2: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_B,
            bridgeLockTime: 1000,
          },
        },
      },
    ];

    const result = getAllBridges(strategies);
    expect(result).to.have.members([BRIDGE_A, BRIDGE_B]);
    expect(result).to.have.lengthOf(2);
  });

  it('should handle overrides without bridge property', () => {
    const strategies: StrategyConfig[] = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          chain1: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
            override: {
              chain2: {
                bridgeMinAcceptedAmount: 5000, // Override without bridge
              },
            },
          },
          chain2: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: BRIDGE_A,
            bridgeLockTime: 1000,
          },
        },
      },
    ];

    const result = getAllBridges(strategies);
    expect(result).to.deep.equal([BRIDGE_A]);
  });
});

describe('pendingTransferMiddlewares configuration', () => {
  const TEST_CONFIG_PATH_MIDDLEWARES = join(
    tmpdir(),
    'rebalancer-pending-transfer-middlewares-test.yaml',
  );

  function writeConfig(pendingTransferMiddlewares: unknown): void {
    writeYamlOrJson(TEST_CONFIG_PATH_MIDDLEWARES, {
      warpRouteId: 'USDC/radix',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 50, tolerance: 10 },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1800,
            },
            arbitrum: {
              weighted: { weight: 50, tolerance: 10 },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1800,
            },
          },
        },
      ],
      pendingTransferMiddlewares,
    });
  }

  afterEach(() => {
    rmSync(TEST_CONFIG_PATH_MIDDLEWARES, { force: true });
  });

  it('leaves middlewares unset when the field is absent', () => {
    writeConfig(undefined);

    expect(
      RebalancerConfig.load(TEST_CONFIG_PATH_MIDDLEWARES)
        .pendingTransferMiddlewares,
    ).to.equal(undefined);
  });

  it('loads middlewares in order, with defaults and duplicate types', () => {
    writeConfig([
      {
        type: 'relayerDenylist',
        url: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/relayer/mainnet-denylist.json',
      },
      { type: 'blacklistIsm', refreshIntervalSecs: 300 },
      {
        type: 'relayerDenylist',
        url: 'file:///etc/rebalancer/denylist.json',
        refreshIntervalSecs: 30,
      },
      { type: 'blacklistIsm' },
    ]);

    expect(
      RebalancerConfig.load(TEST_CONFIG_PATH_MIDDLEWARES)
        .pendingTransferMiddlewares,
    ).to.deep.equal([
      {
        type: PendingTransferMiddlewareType.RelayerDenylist,
        url: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/relayer/mainnet-denylist.json',
        refreshIntervalSecs: 60,
      },
      {
        type: PendingTransferMiddlewareType.BlacklistIsm,
        refreshIntervalSecs: 300,
      },
      {
        type: PendingTransferMiddlewareType.RelayerDenylist,
        url: 'file:///etc/rebalancer/denylist.json',
        refreshIntervalSecs: 30,
      },
      {
        type: PendingTransferMiddlewareType.BlacklistIsm,
        refreshIntervalSecs: 600,
      },
    ]);
  });

  interface InvalidMiddlewareCase {
    name: string;
    middlewares: unknown;
    error: RegExp;
  }
  const invalidCases: InvalidMiddlewareCase[] = [
    {
      name: 'an unknown type',
      middlewares: [{ type: 'ageCap' }],
      error: /pendingTransferMiddlewares/,
    },
    {
      name: 'a denylist without url',
      middlewares: [{ type: 'relayerDenylist' }],
      error: /url/,
    },
    {
      name: 'a denylist url with an unsupported protocol',
      middlewares: [
        { type: 'relayerDenylist', url: 'ftp://example.com/x.json' },
      ],
      error: /url must be an https:\/\/, http:\/\/ or file:\/\/ URL/,
    },
    {
      name: 'a denylist url with credentials',
      middlewares: [
        {
          type: 'relayerDenylist',
          url: 'https://user:hunter2@example.com/x.json',
        },
      ],
      error: /url must not contain credentials/,
    },
    {
      name: 'a non-positive refresh interval',
      middlewares: [
        {
          type: 'relayerDenylist',
          url: 'https://example.com/x.json',
          refreshIntervalSecs: 0,
        },
      ],
      error: /refreshIntervalSecs/,
    },
    {
      name: 'a non-integer blacklistIsm refresh interval',
      middlewares: [{ type: 'blacklistIsm', refreshIntervalSecs: 1.5 }],
      error: /refreshIntervalSecs/,
    },
    {
      name: 'a misspelled denylist key',
      middlewares: [
        {
          type: 'relayerDenylist',
          url: 'https://example.com/x.json',
          refreshIntervalSec: 30,
        },
      ],
      error: /Unrecognized key: "refreshIntervalSec"/,
    },
    {
      name: 'a misspelled blacklistIsm key',
      middlewares: [{ type: 'blacklistIsm', refreshIntervalSec: 300 }],
      error: /Unrecognized key: "refreshIntervalSec"/,
    },
    {
      name: 'a non-array value',
      middlewares: { blacklistIsm: {} },
      error: /pendingTransferMiddlewares/,
    },
  ];
  for (const c of invalidCases) {
    it(`rejects ${c.name}`, () => {
      writeConfig(c.middlewares);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_MIDDLEWARES))
        .to.throw(c.error)
        .with.property('message')
        .that.does.not.include('hunter2');
    });
  }
});
