import {
  type Address,
  type BlockTag,
  type Hex,
  type PublicClient,
  createPublicClient,
  http,
  isAddress,
  isHex,
} from 'viem';

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

function assertAddress(value: string): asserts value is Address {
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`);
}

function assertHex(value: string, fieldName: string): asserts value is Hex {
  if (!isHex(value)) throw new Error(`Invalid ${fieldName}: ${value}`);
}

function isBlockTag(value: string): value is BlockTag {
  return (
    value === 'latest' ||
    value === 'earliest' ||
    value === 'pending' ||
    value === 'safe' ||
    value === 'finalized'
  );
}

function toBlockRef(value: string): Hex | BlockTag {
  if (isBlockTag(value)) return value;
  assertHex(value, 'block');
  return value;
}

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
    assertAddress(address);
    const hexStorageKeys = storageKeys.map((key) => {
      assertHex(key, 'storage key');
      return key;
    });
    const blockRef = toBlockRef(block);
    const results = await this.client.request({
      method: 'eth_getProof',
      params: [address, hexStorageKeys, blockRef],
    });

    return results as ProofResult;
  }
}

export { RPCService, ProofResult };
