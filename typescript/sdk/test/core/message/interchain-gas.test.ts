import { expect } from 'chai';
import { ethers } from 'ethers';

import { AbacusCore, InterchainGasPayingMessage } from '../../../src/core';

export const addresses = {
  test1: {
    upgradeBeaconController: '0x0000000000000000000000000000000000000000',
    xAppConnectionManager: '0x0000000000000000000000000000000000000000',
    validatorManager: '0x0000000000000000000000000000000000000000',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000000',
    outbox: {
      proxy: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
      beacon: '0x0000000000000000000000000000000000000000',
    },
    inboxes: {
      test2: {
        proxy: '0x0000000000000000000000000000000000000000',
        implementation: '0x0000000000000000000000000000000000000000',
        beacon: '0x0000000000000000000000000000000000000000',
      },
    },
  },
  test2: {
    upgradeBeaconController: '0x0000000000000000000000000000000000000000',
    xAppConnectionManager: '0x0000000000000000000000000000000000000000',
    validatorManager: '0x0000000000000000000000000000000000000000',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000000',
    outbox: {
      proxy: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
      beacon: '0x0000000000000000000000000000000000000000',
    },
    inboxes: {
      test1: {
        proxy: '0x0000000000000000000000000000000000000000',
        implementation: '0x0000000000000000000000000000000000000000',
        beacon: '0x0000000000000000000000000000000000000000',
      },
    },
  }
}

class MockProvider extends ethers.providers.BaseProvider {
  perform(method: string, params: any): Promise<any> {
    if (method === "getGasPrice") {
      return Promise.resolve(12345);
    }
    return super.perform(method, params);
  }
}

describe('InterchainGasPayingMessage', () => {
  let core: AbacusCore;

  before(() => {
    core = new AbacusCore(addresses);
    const mockProvider = new MockProvider(31337);
    core.registerProvider('test1', mockProvider);
    core.registerProvider('test2', mockProvider);
  });

  it('can run a test', () => {
    expect(true).to.be.true;

    // TODO craft this in a better
    const empty = '0x00000001000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000';

    new InterchainGasPayingMessage(core, empty);
  });
});
