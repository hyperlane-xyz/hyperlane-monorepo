import { describe, expect, test } from '@jest/globals';

import * as config from '../../src/config';
import { RPCService } from '../../src/services/RPCService';

describe('RPCService', () => {
  const rpcService = new RPCService(config.RPC_ADDRESS);

  test('should return the proofs from api', async () => {
    const proofs = await rpcService.getProofs(
      '0x3ef546f04a1b24eaf9dce2ed4338a1b5c32e2a56',
      ['0x02c1eed75677f1bd39cc3abdd3042974bf12ab4a12ecc40df73fe3aa103e5e0e'],
      '0x1221E88',
    );

    expect(proofs).not.toBeNull();
  });
});
