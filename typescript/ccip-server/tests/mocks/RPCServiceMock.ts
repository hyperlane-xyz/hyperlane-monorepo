import { RPCService } from '../../src/services/RPCService';

class RPCServiceMock extends RPCService {
  getProofs = async (
    address: string,
    storageKeys: string[],
    block: string,
  ): Promise<any> => {
    return {
      jsonrpc: '2.0',
      id: 1,
      result: {
        address,
        accountProof: [],
        storageProof: storageKeys.map((key) => ({
          key,
          proof: [],
          value: '0x',
        })),
        balance: '0x0',
        codeHash: '0x',
        nonce: '0x0',
        storageHash: '0x',
      },
    };
  };
}

export { RPCServiceMock };
