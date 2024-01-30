import { ethers } from 'ethers';

import { telepathyCcipReadIsmAbi } from '../../src/abis/TelepathyCcipReadIsmAbi';
import * as config from '../../src/config';
import { SuccinctProverService } from '../../src/services/SuccinctProverService';

describe('getProofs', () => {
  const provider = new ethers.providers.JsonRpcProvider(config.RPC_ADDRESS);
  const lightClient = new ethers.Contract(
    config.LIGHT_CLIENT_ADDR,
    telepathyCcipReadIsmAbi,
    provider,
  );
  const succinctProverService = new SuccinctProverService(
    provider,
    lightClient,
    config.STEP_FN_ID,
    config.CHAIN_ID,
    config.SUCCINCT_PLATFORM_URL,
    config.SUCCINCT_PLATFORM_URL,
  );

  test('should return the proofs from api', async () => {
    const proofs = await succinctProverService.getProofsFromProvider(
      '0xc005dc82818d67af737725bd4bf75435d065d239',
      ['0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff'],
      '0x1221E88',
    );

    expect(proofs).not.toBeNull();
  });

  test('should return account and storage proof', async () => {
    // Calls TelepathyCcipReadIsm.verify() with state root
  });
});
