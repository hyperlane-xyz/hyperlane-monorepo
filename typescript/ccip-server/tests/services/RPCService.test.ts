import { describe, expect, jest, test } from '@jest/globals';

import { RPCService } from '../../src/services/RPCService';

describe('RPCService', () => {
  test('should return the proofs from api', async () => {
    const rpcService = new RPCService('http://localhost:8545');
    const expectedProof = {
      accountProof: [],
      storageProof: [],
      address: '0x3ef546f04a1b24eaf9dce2ed4338a1b5c32e2a56',
      balance: '0x0',
      codeHash: '0x0',
      nonce: '0x0',
      storageHash: '0x0',
    };
    const sendSpy = jest
      .spyOn(rpcService.provider, 'send')
      .mockResolvedValue(expectedProof);

    const proofs = await rpcService.getProofs(
      '0x3ef546f04a1b24eaf9dce2ed4338a1b5c32e2a56',
      ['0x02c1eed75677f1bd39cc3abdd3042974bf12ab4a12ecc40df73fe3aa103e5e0e'],
      '0x1221E88',
    );

    expect(sendSpy).toHaveBeenCalledWith('eth_getProof', [
      '0x3ef546f04a1b24eaf9dce2ed4338a1b5c32e2a56',
      ['0x02c1eed75677f1bd39cc3abdd3042974bf12ab4a12ecc40df73fe3aa103e5e0e'],
      '0x1221E88',
    ]);
    expect(proofs).toEqual(expectedProof);
  });
});
