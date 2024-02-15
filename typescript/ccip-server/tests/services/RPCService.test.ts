import * as config from '../../src/config';
import { RPCService } from '../../src/services/RPCService';

describe('RPCService', () => {
  const rpcService = new RPCService(config.RPC_ADDRESS);

  test('should return the proofs from api', async () => {
    const proofs = await rpcService.getProofs(
      '0xc005dc82818d67af737725bd4bf75435d065d239',
      ['0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff'],
      '0x1221E88',
    );

    expect(proofs).not.toBeNull();
  });
});
