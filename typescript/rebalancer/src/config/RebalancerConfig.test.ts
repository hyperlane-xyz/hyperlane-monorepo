import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { z } from 'zod';

import { writeYamlOrJson } from '@hyperlane-xyz/utils/fs';

import { RebalancerConfig } from './RebalancerConfig.js';
import {
  ExecutionType,
  ExternalBridgeType,
  type RebalancerConfigFileInput,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
  getAllBridges,
} from './types.js';

const TEST_CONFIG_PATH = join(tmpdir(), 'rebalancer-config-test.yaml');

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
      inventorySigner: undefined,
      externalBridges: undefined,
    });
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
      'Validation error: Required at "warpRouteId"',
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
      inventorySigner: '0x1234567890123456789012345678901234567890',
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
      inventorySigner: '0x1234567890123456789012345678901234567890',
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

  it('should require externalBridges.lifi when executionType is inventory', () => {
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
      inventorySigner: '0x1234567890123456789012345678901234567890',
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /externalBridges\.lifi.*required/i,
    );
  });

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
      inventorySigner: '0x1234567890123456789012345678901234567890',
    };

    writeYamlOrJson(TEST_CONFIG_PATH_BRIDGE, data);

    expect(() => RebalancerConfig.load(TEST_CONFIG_PATH_BRIDGE)).to.throw(
      /externalBridges\.lifi.*required|lifi.*not configured/i,
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
