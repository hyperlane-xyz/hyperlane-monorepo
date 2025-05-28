import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';

import {
  ANVIL_KEY,
  REBALANCER_CONFIG_PATH,
} from '../../tests/commands/helpers.js';
import { ENV } from '../../utils/env.js';
import { writeYamlOrJson } from '../../utils/files.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

import { Config, type ConfigFileInput, MinAmountType } from './Config.js';

describe('Config', () => {
  let coingeckoApiKeyBackup: string | undefined;
  let data: ConfigFileInput;
  let overrides: Parameters<typeof Config.load>[2];

  beforeEach(() => {
    coingeckoApiKeyBackup = ENV.COINGECKO_API_KEY;

    data = {
      warpRouteId: 'warpRouteId',
      rebalanceStrategy: StrategyOptions.Weighted,
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
    };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    overrides = {
      checkFrequency: 1000,
      monitorOnly: false,
      withMetrics: false,
    };

    ENV.COINGECKO_API_KEY = 'coingeckoApiKey';
  });

  afterEach(() => {
    rmSync(REBALANCER_CONFIG_PATH, { force: true });

    ENV.COINGECKO_API_KEY = coingeckoApiKeyBackup;
  });

  it('should throw when the config file does not exist', () => {
    rmSync(REBALANCER_CONFIG_PATH, { force: true });

    expect(() =>
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
    ).to.throw(`File doesn't exist at ${REBALANCER_CONFIG_PATH}`);
  });

  it('should load config from file', () => {
    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
    ).to.deep.equal({
      warpRouteId: 'warpRouteId',
      checkFrequency: overrides.checkFrequency,
      rebalancerKey: ANVIL_KEY,
      monitorOnly: overrides.monitorOnly,
      withMetrics: overrides.withMetrics,
      coingeckoApiKey: ENV.COINGECKO_API_KEY,
      rebalanceStrategy: StrategyOptions.Weighted,
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
    delete data.chain1;
    delete data.chain2;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(() =>
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
    ).to.throw('No chains configured');
  });

  it('should throw if no warp route id is configured', () => {
    // @ts-ignore
    delete data.warpRouteId;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(() =>
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
    ).to.throw('Validation error: Required at "warpRouteId"');
  });

  it('should prefer using overrides rather than config file', () => {
    overrides = {
      checkFrequency: 1337,
      monitorOnly: false,
      withMetrics: false,
      rebalanceStrategy: StrategyOptions.Weighted,
    };

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
    ).to.deep.equal({
      warpRouteId: 'warpRouteId',
      checkFrequency: overrides.checkFrequency,
      monitorOnly: overrides.monitorOnly,
      rebalancerKey: ANVIL_KEY,
      withMetrics: overrides.withMetrics,
      coingeckoApiKey: ENV.COINGECKO_API_KEY,
      rebalanceStrategy: overrides.rebalanceStrategy,
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

  it('should load relative params without modifications', () => {
    data.rebalanceStrategy = StrategyOptions.MinAmount;
    delete data.chain1.weighted;

    data.chain1 = {
      ...data.chain1,
      minAmount: {
        min: '0.2',
        target: 0.3,
        type: MinAmountType.Relative,
      },
    };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides).chains.chain1,
    ).to.deep.equal({
      ...data.chain1,
      bridgeLockTime: 1_000,
      minAmount: {
        min: '0.2',
        target: 0.3,
        type: MinAmountType.Relative,
      },
    });
  });

  it('should load absolute params without modifications', () => {
    data.rebalanceStrategy = StrategyOptions.MinAmount;
    delete data.chain1.weighted;

    data.chain1 = {
      ...data.chain1,
      minAmount: {
        min: '100000',
        target: 140000,
        type: MinAmountType.Absolute,
      },
    };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides).chains.chain1,
    ).to.deep.equal({
      ...data.chain1,
      bridgeLockTime: 1_000,
      minAmount: {
        min: '100000',
        target: 140000,
        type: MinAmountType.Absolute,
      },
    });
  });

  describe('override functionality', () => {
    it('should parse a config with overrides', () => {
      data = {
        warpRouteId: 'warpRouteId',
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: {
            min: 1000,
            target: 1100,
            type: MinAmountType.Absolute,
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
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain3: {
          minAmount: {
            min: 3000,
            target: 3300,
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      const config = Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides);
      expect(config.chains.chain1).to.have.property('override');

      const override = config.chains.chain1.override;
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
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: {
            min: 1000,
            target: 1100,
            type: MinAmountType.Absolute,
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
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      expect(() =>
        Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
      ).to.throw(
        "Chain 'chain1' has an override for 'chain3', but 'chain3' is not defined in the config",
      );
    });

    it('should throw when an override references itself', () => {
      data = {
        warpRouteId: 'warpRouteId',
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: {
            min: 1000,
            target: 1100,
            type: MinAmountType.Absolute,
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
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      expect(() =>
        Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides),
      ).to.throw(
        "Chain 'chain1' has an override for 'chain1', but 'chain1' is self-referencing",
      );
    });

    it('should allow multiple chain overrides', () => {
      data.chain1 = {
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

      data.chain2 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 5000,
        bridgeLockTime: 1,
        weighted: {
          weight: 100,
          tolerance: 0,
        },
      };

      data.chain3 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 6000,
        bridgeLockTime: 1,
        weighted: {
          weight: 100,
          tolerance: 0,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      const config = Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, overrides);

      const chain1Overrides = config.chains.chain1.override;
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
