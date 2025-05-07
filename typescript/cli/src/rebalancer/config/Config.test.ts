import { expect } from 'chai';
import { ethers } from 'ethers';
import { rmSync } from 'fs';

import {
  ANVIL_KEY,
  REBALANCER_CONFIG_PATH,
} from '../../tests/commands/helpers.js';
import { writeYamlOrJson } from '../../utils/files.js';

import { Config } from './Config.js';

describe('Config', () => {
  let data: any;

  beforeEach(() => {
    data = {
      warpRouteId: 'warpRouteId',
      checkFrequency: 1000,
      chain1: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
      },
      chain2: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
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
      monitorOnly: false,
      withMetrics: false,
      chains: {
        chain1: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
        chain2: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
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
      }),
    ).to.deep.equal({
      warpRouteId: 'warpRouteId by override',
      checkFrequency: 1337,
      monitorOnly: false,
      withMetrics: false,
      chains: {
        chain1: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
        chain2: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
      },
    });
  });
});
