import { HyperlaneService } from './HyperlaneService';
import { ProofResult, RPCService } from './RPCService';

class ProofsService {
  rpcService: RPCService;
  hyperlaneService: HyperlaneService;

  constructor(
    rpcUrl: Required<string>,
    hyperlaneExplorerUrl: Required<string>,
  ) {
    this.rpcService = new RPCService(rpcUrl);
    this.hyperlaneService = new HyperlaneService(hyperlaneExplorerUrl);
  }

  /**
   * Requests the account and storage proofs for a given storage key and messageId
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param messageId messageId that will be used to get the block info from Hyperlane
   * @returns The account and a single storage proof
   */
  async getProofs(
    target: string,
    storageKey: string,
    messageId: string,
  ): Promise<Array<[string[], string[]]>> {
    const { blockNumber } =
      await this.hyperlaneService.getOriginBlockByMessageId(messageId);
    const { accountProof, storageProof }: ProofResult =
      await this.rpcService.getProofs(
        target,
        [storageKey],
        new Number(blockNumber).toString(16), // Converts to hexstring
      );

    return [[accountProof, storageProof[0].proof]]; // Since we only expect one storage key, we only return the first proof
  }
}

export { ProofsService };
