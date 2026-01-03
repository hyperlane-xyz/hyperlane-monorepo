import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeYamlOrJson } from '@hyperlane-xyz/utils/fs';

import { RebalancerConfig } from './RebalancerConfig.js';
import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  getStrategyChainConfig,
} from './types.js';

// Type for test config input (weighted strategy)
type WeightedConfigInput = {
  warpRouteId: string;
  strategy: {
    rebalanceStrategy: typeof RebalancerStrategyOptions.Weighted;
    chains: Record<
      string,
      {
        weighted: { weight: number; tolerance: number };
        bridge: string;
        bridgeLockTime: number;
        bridgeMinAcceptedAmount?: number;
        override?: Record<
          string,
          {
            bridge?: string;
            bridgeLockTime?: number;
            bridgeMinAcceptedAmount?: number;
          }
        >;
      }
    >;
  };
};

// Type for test config input (minAmount strategy)
type MinAmountConfigInput = {
  warpRouteId: string;
  strategy: {
    rebalanceStrategy: typeof RebalancerStrategyOptions.MinAmount;
    chains: Record<
      string,
      {
        minAmount: {
          min: string | number;
          target: number;
          type: RebalancerMinAmountType;
        };
        bridge: string;
        bridgeLockTime: number;
        override?: Record<
          string,
          {
            bridge?: string;
            bridgeLockTime?: number;
            bridgeMinAcceptedAmount?: number;
          }
        >;
      }
    >;
  };
};

const TEST_CONFIG_PATH = join(tmpdir(), 'rebalancer-config-test.yaml');

describe('RebalancerConfig', () => {
  let data: WeightedConfigInput;

  beforeEach(() => {
    data = {
      warpRouteId: 'warpRouteId',
      strategy: {
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
    const config = RebalancerConfig.load(TEST_CONFIG_PATH);
    expect(config.warpRouteId).to.equal('warpRouteId');
    expect(config.explorerUrl).to.be.undefined;
    expect(config.strategyConfig).to.deep.equal({
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
    });
  });

  it('should throw if chains are not configured', () => {
    const emptyData: WeightedConfigInput = {
      ...data,
      strategy: { ...data.strategy, chains: {} },
    };

    writeYamlOrJson(TEST_CONFIG_PATH, emptyData);

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
    const minAmountData: MinAmountConfigInput = {
      warpRouteId: 'warpRouteId',
      strategy: {
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
    };

    writeYamlOrJson(TEST_CONFIG_PATH, minAmountData);

    const config = RebalancerConfig.load(TEST_CONFIG_PATH);
    const chain1Config = getStrategyChainConfig(
      config.strategyConfig,
      'chain1',
    );
    expect(chain1Config).to.deep.equal({
      ...minAmountData.strategy.chains.chain1,
      bridgeLockTime: 1_000,
    });
  });

  it('should load absolute params without modifications', () => {
    const minAmountData: MinAmountConfigInput = {
      warpRouteId: 'warpRouteId',
      strategy: {
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
    };

    writeYamlOrJson(TEST_CONFIG_PATH, minAmountData);

    const config = RebalancerConfig.load(TEST_CONFIG_PATH);
    const chain1Config = getStrategyChainConfig(
      config.strategyConfig,
      'chain1',
    );
    expect(chain1Config).to.deep.equal({
      ...minAmountData.strategy.chains.chain1,
      bridgeLockTime: 1_000,
    });
  });

  describe('explorerUrl and rebalancerAddress', () => {
    it('should load config with explorerUrl and rebalancerAddress', () => {
      const configWithExplorer = {
        ...data,
        explorerUrl: 'https://explorer.hyperlane.xyz',
        rebalancerAddress: '0x1234567890123456789012345678901234567890',
      };

      writeYamlOrJson(TEST_CONFIG_PATH, configWithExplorer);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);
      expect(config.explorerUrl).to.equal('https://explorer.hyperlane.xyz');
      expect(config.rebalancerAddress).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should throw when explorerUrl is set but rebalancerAddress is missing', () => {
      const configWithExplorerOnly = {
        ...data,
        explorerUrl: 'https://explorer.hyperlane.xyz',
      };

      writeYamlOrJson(TEST_CONFIG_PATH, configWithExplorerOnly);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        'rebalancerAddress is required when explorerUrl is set',
      );
    });

    it('should allow rebalancerAddress without explorerUrl', () => {
      const configWithAddressOnly = {
        ...data,
        rebalancerAddress: '0x1234567890123456789012345678901234567890',
      };

      writeYamlOrJson(TEST_CONFIG_PATH, configWithAddressOnly);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);
      expect(config.explorerUrl).to.be.undefined;
      expect(config.rebalancerAddress).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should throw when rebalancerAddress is not a valid address', () => {
      const configWithInvalidAddress = {
        ...data,
        explorerUrl: 'https://explorer.hyperlane.xyz',
        rebalancerAddress: 'not-an-address',
      };

      writeYamlOrJson(TEST_CONFIG_PATH, configWithInvalidAddress);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw();
    });

    it('should throw when explorerUrl is not a valid URL', () => {
      const configWithInvalidUrl = {
        ...data,
        explorerUrl: 'not-a-url',
        rebalancerAddress: '0x1234567890123456789012345678901234567890',
      };

      writeYamlOrJson(TEST_CONFIG_PATH, configWithInvalidUrl);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw();
    });
  });

  describe('override functionality', () => {
    it('should parse a config with overrides', () => {
      const minAmountData: MinAmountConfigInput = {
        warpRouteId: 'warpRouteId',
        strategy: {
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
      };

      writeYamlOrJson(TEST_CONFIG_PATH, minAmountData);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);
      const chain1Config = getStrategyChainConfig(
        config.strategyConfig,
        'chain1',
      );
      expect(chain1Config).to.have.property('override');

      const override = chain1Config!.override;
      expect(override).to.not.be.undefined;
      expect(override).to.have.property('chain2');

      const toChain2Override = override!.chain2;
      expect(toChain2Override).to.have.property('bridge');
      expect(toChain2Override.bridge).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should throw when an override references a non-existent chain', () => {
      const minAmountData: MinAmountConfigInput = {
        warpRouteId: 'warpRouteId',
        strategy: {
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
      };

      writeYamlOrJson(TEST_CONFIG_PATH, minAmountData);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        "Chain 'chain1' has an override for 'chain3', but 'chain3' is not defined in the config",
      );
    });

    it('should throw when an override references itself', () => {
      const minAmountData: MinAmountConfigInput = {
        warpRouteId: 'warpRouteId',
        strategy: {
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
      };

      writeYamlOrJson(TEST_CONFIG_PATH, minAmountData);

      expect(() => RebalancerConfig.load(TEST_CONFIG_PATH)).to.throw(
        "Chain 'chain1' has an override for 'chain1', but 'chain1' is self-referencing",
      );
    });

    it('should allow multiple chain overrides', () => {
      const overrideData: WeightedConfigInput = {
        warpRouteId: 'warpRouteId',
        strategy: {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            chain1: {
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
            },
            chain2: {
              bridge: ethers.constants.AddressZero,
              bridgeMinAcceptedAmount: 5000,
              bridgeLockTime: 1,
              weighted: {
                weight: 100,
                tolerance: 0,
              },
            },
            chain3: {
              bridge: ethers.constants.AddressZero,
              bridgeMinAcceptedAmount: 6000,
              bridgeLockTime: 1,
              weighted: {
                weight: 100,
                tolerance: 0,
              },
            },
          },
        },
      };

      writeYamlOrJson(TEST_CONFIG_PATH, overrideData);

      const config = RebalancerConfig.load(TEST_CONFIG_PATH);

      const chain1Config = getStrategyChainConfig(
        config.strategyConfig,
        'chain1',
      );
      const chain1Overrides = chain1Config!.override;
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
});
