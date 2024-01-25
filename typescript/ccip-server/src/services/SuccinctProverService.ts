import { telepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';
import axios from 'axios';
import { ethers, constants, utils } from 'ethers';

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
type Proof = {
  jsonrpc: string;
  id: number;
  result: ProofResult;
};

class SuccinctProverService {
  provider: ethers.providers.JsonRpcProvider;
  lightClient: ethers.Contract;

  constructor(
    private readonly rpcAddress: string,
    private readonly lightClientAddress: string,
    private readonly stepFunctionId: string,
    private readonly chainId: string,
    private readonly platformUrl: string,
    private readonly platformApiKey: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcAddress);
    this.lightClient = new ethers.Contract(lightClientAddress, telepathyCcipReadIsmAbi, this.provider);
  }

  private getSyncCommitteePeriod(slot: bigint): bigint {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets Succinct proof, state proof, and returns encoded account and storage proof
   * @param address
   * @param storageKeys
   * @param block
   * @returns
   */
  async getProofs(address: string, storageKeys: string[], block: string): Promise<string> {
    // Gets the sync committee poseidon associated with the slot
    const slot = 0n; // TODO figure out which slot to use
    const syncCommitteePoseidon = await this.getSyncCommitteePoseidons(slot);

    // No Sync committee poseidon for this slot, return empty proof
    if (syncCommitteePoseidon == constants.HashZero) return constants.HashZero;

    await this.requestProofFromSuccinct(slot, syncCommitteePoseidon);
    const { result } = await this.getProofsFromProvider(address, storageKeys, block);

    // Abi encode the proofs
    return utils.defaultAbiCoder.encode(['string[]', 'string[]'], [result.accountProof, result.storageProof]);
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  async getSyncCommitteePoseidons(slot: bigint): Promise<any> {
    return await this.lightClient.syncCommitteePoseidons(this.getSyncCommitteePeriod(slot));
  }

  /**
   * Request the proof from Succinct
   * @param slot
   * @param syncCommitteePoseidon
   */
  async requestProofFromSuccinct(slot: bigint, syncCommitteePoseidon: bigint) {
    const telepathyIface = new utils.Interface(telepathyCcipReadIsmAbi);
    const body = {
      chainId: this.chainId,
      to: this.lightClientAddress,
      data: telepathyIface.encodeFunctionData('step', [slot]),
      functionId: this.stepFunctionId,
      input: utils.defaultAbiCoder.encode(['bytes32', 'uint64'], [syncCommitteePoseidon, slot]),
      retry: true,
    };

    await axios.post(this.platformUrl, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.platformApiKey}`,
      },
      body, // body data type must match "Content-Type" header
    });

    // If the proof is not ready, return 404 so Relayer retries
  }

  /**
   * Request state proofs using eth_getProofs
   * @param address
   * @param storageKeys
   * @param block
   * @returns
   */
  async getProofsFromProvider(address: string, storageKeys: string[], block = 'latest'): Promise<Proof> {
    const { data } = await axios.post(this.rpcAddress, {
      method: 'eth_getProof',
      params: [address, storageKeys, block],
      id: 1,
      jsonrpc: '2.0',
    });

    return data;
  }
}

export { SuccinctProverService };
