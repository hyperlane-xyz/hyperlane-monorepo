import ETH_GET_PROOFS from '../../../../../solidity/test/test-data/getProof-data.json' with { type: 'json' };

class RPCService {
  getProofs = async (
    _address: string,
    _storageKeys: string[],
    _block: string,
  ): Promise<any> => {
    return ETH_GET_PROOFS;
  };
}

export { RPCService };
