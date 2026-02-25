import { type PublicClient, createPublicClient, http } from 'viem';

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
  private readonly client: PublicClient;
  constructor(private readonly providerAddress: string) {
    this.client = createPublicClient({
      transport: http(this.providerAddress),
    });
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
    const results = await this.client.request({
      method: 'eth_getProof',
      params: [address, storageKeys, block],
    });

    return results as ProofResult;
  }
}

export { RPCService, ProofResult };
