import ETH_GET_PROOFS from '../../../../../solidity/test/test-data/getProof-data.json';

class RPCService {
  getProofs = async (
    address: string,
    storageKeys: string[],
    block: string,
  ): Promise<any> => {
    return ETH_GET_PROOFS;
  };
}

export { RPCService };
