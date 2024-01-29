import { constants } from 'ethers';

import { SuccinctProverService } from '../../src/services/SuccinctProverService';

const RPC_ADDRESS =
  process.env.RPC_ADDRESS || 'https://docs-demo.quiknode.pro/'; // TODO parameterize this
const PLATFORM_URL =
  process.env.PLATFORM_URL || 'https://alpha.succinct.xyz/api/request/new';

describe('getProofs', () => {
  const succinctProverService = new SuccinctProverService(
    RPC_ADDRESS, // rpcAddress
    constants.AddressZero, // lightClientAddress
    constants.HashZero, // stepFunctionId
    constants.One.toString(), // chainId
    PLATFORM_URL, // platformUrl
    '', // platformApiKey
  );

  test('should return the proofs from api', async () => {
    const proofs = await succinctProverService.getProofsFromProvider(
      '0xc005dc82818d67af737725bd4bf75435d065d239',
      ['0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff'],
      '0x1221E88',
    );

    expect(proofs).not.toBeNull();
  });

  test('should verify with the correct proofs onchain', async () => {
    // Calls TelepathyCcipReadIsm.verify() with state root
  });
});
