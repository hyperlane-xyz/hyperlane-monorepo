import { ethers } from 'ethers';

type ProofResultStorageProof = {
  key: string;
  proof: Array<string>;
  value: string;
};

type ProofResult = {
  accountProof: Array<string>;
  storageProof: Array<ProofResultStorageProof>;
  address: string;
  balance: string;
  codeHash: string;
  nonce: string;
  storageHash: string;
};

class RPCService {
  provider: ethers.providers.JsonRpcProvider;
  constructor(private readonly providerAddress: string) {
    this.provider = new ethers.providers.JsonRpcProvider(this.providerAddress);
  }

  /**
   * Request state proofs using eth_getProofs
   * @param address
   * @param storageKeys
   * @param block
   * @returns
   */
  async getProofs(
    address: string,
    storageKeys: string[],
    block: string,
  ): Promise<ProofResult> {
    const results = await this.provider.send('eth_getProof', [
      address,
      storageKeys,
      block,
    ]);

    return results;
  }
}

export { RPCService, ProofResult };
