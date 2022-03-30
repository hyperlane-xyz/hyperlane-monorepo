import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';

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

const MOCK_NETWORK = {
  name: 'MockNetwork',
  chainId: 1337,
};
class MockProvider extends ethers.providers.BaseProvider {
  constructor() {
    super(MOCK_NETWORK);
  }

  // Required to be implemented or the BaseProvider throws
  async detectNetwork() {
    return Promise.resolve(MOCK_NETWORK);
  }
  
  perform(method: string, params: any): Promise<any> {
    console.log('method', method)

    switch (method) {
      case 'getGasPrice':
        return Promise.resolve(
          BigNumber.from(12345)
        );
      case 'estimateGas':
        return Promise.resolve(
          BigNumber.from(21000)
        );
    }
    
    return super.perform(method, params);
  }
}

describe('InterchainGasPayingMessage', () => {
  let core: AbacusCore;

  before(() => {
    core = new AbacusCore(addresses);
    const mockProvider = new MockProvider();
    core.registerProvider('test1', mockProvider);
    core.registerProvider('test2', mockProvider);
  });

  it('can run a test', async () => {
    expect(true).to.be.true;

    // TODO craft this in a better way
    // use formatMessage
    const empty = '0x000000010000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

    const gasPayingMessage = new InterchainGasPayingMessage(core, empty);
    // gasPayingMessage.estimateDestinationGas = () => Promise.resolve(ethers.BigNumber.from(21000));

    console.log(
      'estimateInterchainGasPayment',
      (await gasPayingMessage.estimateInterchainGasPayment()).toString()
    );

    console.log('source decimals', gasPayingMessage.sourceTokenDecimals)
    console.log('dest decimals', gasPayingMessage.destinationTokenDecimals)
  });
});
