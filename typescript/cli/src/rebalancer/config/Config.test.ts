import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';

import {
  ANVIL_KEY,
  COINGECKO_API_KEY,
  REBALANCER_CONFIG_PATH,
} from '../../tests/commands/helpers.js';
import { writeYamlOrJson } from '../../utils/files.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

import { Config } from './Config.js';

describe('Config', () => {
  let data: any;

  beforeEach(() => {
    data = {
      warpRouteId: 'warpRouteId',
      checkFrequency: 1000,
      rebalanceStrategy: StrategyOptions.Weighted,
      chain1: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      chain2: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);
  });

  afterEach(() => {
    rmSync(REBALANCER_CONFIG_PATH, { force: true });
  });

  it('should throw when the config file does not exist', () => {
    rmSync(REBALANCER_CONFIG_PATH, { force: true });

    expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
      `File doesn't exist at ${REBALANCER_CONFIG_PATH}`,
    );
  });

  it('should load config from file', () => {
    expect(Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.deep.equal({
      warpRouteId: 'warpRouteId',
      checkFrequency: 1000,
      rebalancerKey: ANVIL_KEY,
      monitorOnly: false,
      withMetrics: false,
      coingeckoApiKey: '',
      rebalanceStrategy: StrategyOptions.Weighted,
      chains: {
        chain1: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain2: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      },
    });
  });

  it('should throw if chains are not configured', () => {
    delete data.chain1;
    delete data.chain2;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
      'No chains configured',
    );
  });

  it('should throw if no warp route id is configured', () => {
    delete data.warpRouteId;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
      'warpRouteId is required',
    );
  });

  it('should load if warp route id is provided by override', () => {
    delete data.warpRouteId;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {
        warpRouteId: 'warpRouteId by override',
      }).warpRouteId,
    ).to.equal('warpRouteId by override');
  });

  it('should throw if no check frequency is configured', () => {
    delete data.checkFrequency;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
      'checkFrequency is required',
    );
  });

  it('should load if check frequency is provided by override', () => {
    delete data.checkFrequency;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, { checkFrequency: 1337 })
        .checkFrequency,
    ).to.equal(1337);
  });

  it('should prefer using overrides rather than config file', () => {
    data.monitorOnly = true;
    data.withMetrics = true;

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {
        warpRouteId: 'warpRouteId by override',
        checkFrequency: 1337,
        monitorOnly: false,
        withMetrics: false,
        coingeckoApiKey: COINGECKO_API_KEY,
        rebalanceStrategy: StrategyOptions.Weighted,
      }),
    ).to.deep.equal({
      warpRouteId: 'warpRouteId by override',
      checkFrequency: 1337,
      monitorOnly: false,
      rebalancerKey: ANVIL_KEY,
      withMetrics: false,
      coingeckoApiKey: COINGECKO_API_KEY,
      rebalanceStrategy: StrategyOptions.Weighted,
      chains: {
        chain1: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain2: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      },
    });
  });

  it('should load relative params without modifications', () => {
    data.rebalanceStrategy = StrategyOptions.MinAmount;
    delete data.chain1.weight;
    delete data.chain1.tolerance;

    data.chain1 = { ...data.chain1, minAmount: '0.2', target: 0.3 };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {}).chains.chain1,
    ).to.deep.equal({
      ...data.chain1,
      minAmount: '0.2',
      target: 0.3,
    });
  });

  it('should load absolute params without modifications', () => {
    data.rebalanceStrategy = StrategyOptions.MinAmount;
    delete data.chain1.weight;
    delete data.chain1.tolerance;

    data.chain1 = { ...data.chain1, minAmount: '100000', target: 140000 };

    writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

    expect(
      Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {}).chains.chain1,
    ).to.deep.equal({
      ...data.chain1,
      minAmount: '100000',
      target: 140000,
    });
  });

  describe('override functionality', () => {
    it('should parse a config with overrides', () => {
      data = {
        warpRouteId: 'warpRouteId',
        checkFrequency: 1000,
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: 1000,
          target: 1100,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
          override: {
            chain2: {
              bridge: '0x1234567890123456789012345678901234567890',
            },
          },
        },
        chain2: {
          minAmount: 2000,
          target: 2200,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain3: {
          minAmount: 3000,
          target: 3300,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      const config = Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {});
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
        checkFrequency: 1000,
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: 1000,
          target: 1100,
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
          minAmount: 2000,
          target: 2200,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
        "Chain 'chain1' has an override for 'chain3', but 'chain3' is not defined in the config",
      );
    });

    it('should throw when an override references itself', () => {
      data = {
        warpRouteId: 'warpRouteId',
        checkFrequency: 1000,
        rebalanceStrategy: StrategyOptions.MinAmount,
        chain1: {
          minAmount: 1000,
          target: 1100,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
          override: {
            chain1: {
              bridgeMinAcceptedAmount: 1000,
            },
          },
        },
        chain2: {
          minAmount: 2000,
          target: 2200,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      expect(() => Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {})).to.throw(
        "Chain 'chain1' has an override for 'chain1', but 'chain1' is self-referencing",
      );
    });

    it('should allow multiple chain overrides', () => {
      data.chain1 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 3000,
        bridgeLockTime: 1,
        weight: 100,
        tolerance: 0,
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
        weight: 100,
        tolerance: 0,
      };

      data.chain3 = {
        bridge: ethers.constants.AddressZero,
        bridgeMinAcceptedAmount: 6000,
        bridgeLockTime: 1,
        weight: 100,
        tolerance: 0,
      };

      writeYamlOrJson(REBALANCER_CONFIG_PATH, data);

      const config = Config.load(REBALANCER_CONFIG_PATH, ANVIL_KEY, {});

      const chain1Overrides = config.chains.chain1.override;
      expect(chain1Overrides).to.not.be.undefined;
      expect(chain1Overrides).to.have.property('chain2');
      expect(chain1Overrides).to.have.property('chain3');

      const chain2Overrides = chain1Overrides!.chain2;
      expect(chain2Overrides).to.have.property('bridgeMinAcceptedAmount');
      expect(chain2Overrides.bridgeMinAcceptedAmount).to.equal(4000n);

      const chain3Overrides = chain1Overrides!.chain3;
      expect(chain3Overrides).to.have.property('bridge');
      expect(chain3Overrides.bridge).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });
  });
});
