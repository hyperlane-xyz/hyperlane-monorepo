import { ethers } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../../src/abis/TelepathyCcipReadIsmAbi';
import { LightClientService } from '../../src/services/LightClientService';
import { RPCService } from '../../src/services/RPCService';

describe('LightClientService', () => {
  let lightClientService: LightClientService;
  beforeEach(() => {
    const rpcService = new RPCService('http://localhost:8545');
    const lightClientContract = new ethers.Contract(
      'lightClientAddress',
      TelepathyCcipReadIsmAbi,
      rpcService.provider,
    );
    lightClientService = new LightClientService(lightClientContract, {
      lightClientAddress: ethers.constants.AddressZero,
      stepFunctionId: ethers.constants.HashZero,
      platformUrl: 'http://localhost:8080',
      apiKey: 'apiKey',
    });

    jest.resetModules();
  });
  test('should return the corret proof status', () => {
    expect(lightClientService.pendingProofId).toBe(undefined);
  });
});
