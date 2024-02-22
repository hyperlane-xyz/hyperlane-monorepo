import * as ETH_GET_PROOFS from '../../../../solidity/test/test-data/getProof-data.json';
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
      result: ETH_GET_PROOFS,
    };
  };
}

export { RPCServiceMock };
