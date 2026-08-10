import { describe, expect, test } from '@jest/globals';

import { assert } from '@hyperlane-xyz/utils';

import { RPCService } from '../../src/services/RPCService';

describe('RPCService', () => {
  const rpcAddress = process.env.RPC_ADDRESS;
  assert(rpcAddress, 'RPC_ADDRESS is required');
  const rpcService = new RPCService(rpcAddress);

  test('should return the proofs from api', async () => {
    const proofs = await rpcService.getProofs(
      '0x3ef546f04a1b24eaf9dce2ed4338a1b5c32e2a56',
      ['0x02c1eed75677f1bd39cc3abdd3042974bf12ab4a12ecc40df73fe3aa103e5e0e'],
      '0x1221E88',
    );

    expect(proofs).not.toBeNull();
  });
});
