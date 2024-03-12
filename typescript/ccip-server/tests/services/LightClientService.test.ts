import { describe, expect, jest, test } from '@jest/globals';
import { BigNumber, ethers } from 'ethers';

import { LightClientService } from '../../src/services/LightClientService';
import { RPCService } from '../../src/services/RPCService';
import { GENESIS_TIME } from '../../src/services/__mocks__/LightClientService';

// Fixtures
jest.mock('../../src/services/LightClientService');
jest.mock('../../src/services/RPCService');

describe('LightClientService', () => {
  let lightClientService: LightClientService;
  beforeEach(() => {
    const rpcService = new RPCService('http://localhost:8545');

    lightClientService = new LightClientService(
      {
        lightClientAddress: ethers.constants.AddressZero,
        stepFunctionId: ethers.constants.HashZero,
        platformUrl: 'http://localhost:8080',
        apiKey: 'apiKey',
        chainId: '1337',
      },
      rpcService.provider,
    );

    jest.resetModules();
  });
  test('should return the correct proof status', async () => {
    const results = await lightClientService.calculateSlot(
      BigNumber.from(GENESIS_TIME + 100),
    );
    expect(results.toBigInt()).toBeGreaterThan(0);
  });
});
