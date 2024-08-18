import { ConsensusService } from './ConsensusService';
import { ProofResult, RPCService } from './RPCService';

class ProofsService {
  rpcService: RPCService;
  consensusService: ConsensusService;

  constructor(rpcUrl: Required<string>, consensusApiUrl: Required<string>) {
    this.rpcService = new RPCService(rpcUrl);
    this.consensusService = new ConsensusService(consensusApiUrl);
  }

  /**
   * Requests the account and storage proofs for a given storage key and slot
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param slot slot that will be used to get the block info from Consensus API
   * @returns The account and a single storage proof
   */
  async getProofs(
    target: string,
    storageKey: string,
    slot: string,
  ): Promise<Array<[string[], string[]]>> {
    const blockNumber = await this.consensusService.getOriginBlockNumberBySlot(
      slot,
    );
    const { accountProof, storageProof }: ProofResult =
      await this.rpcService.getProofs(
        target,
        [storageKey],
        `0x` + new Number(blockNumber).toString(16), // Converts to hexstring
      );
    return [[accountProof, storageProof[0].proof]]; // Since we only expect one storage key, we only return the first proof
  }
}

export { ProofsService };
