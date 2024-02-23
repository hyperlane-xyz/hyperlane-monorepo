import { ethers } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { HyperlaneService } from './HyperlaneService';
import {
  LightClientService,
  ProofStatus,
  SuccinctConfig,
} from './LightClientService';
import { RPCService } from './RPCService';

type RPCConfig = {
  readonly url: string;
  readonly chainId: string;
};

type HyperlaneConfig = {
  readonly url: string;
};

// Service that requests proofs from Succinct and RPC Provider
class ProofsService {
  // Maps from pendingProofKey to pendingProofId
  pendingProofIds = new Map<string, string>();

  // External Services
  rpcService: RPCService;
  lightClientService: LightClientService;
  hyperlaneService: HyperlaneService;

  constructor(
    succinctConfig: Required<SuccinctConfig>,
    rpcConfig: Required<RPCConfig>,
    hyperlaneConfig: Required<HyperlaneConfig>,
  ) {
    this.rpcService = new RPCService(rpcConfig.url);
    const lightClientContract = new ethers.Contract(
      succinctConfig.lightClientAddress,
      TelepathyCcipReadIsmAbi,
      this.rpcService.provider,
    );

    this.lightClientService = new LightClientService(
      lightClientContract,
      succinctConfig,
    );

    this.hyperlaneService = new HyperlaneService(hyperlaneConfig.url);
  }

  /**
   * Requests the Succinct proof, state proof, and returns account and storage proof
   * @dev Upon requesting Succinct Proof, this function will revert to force the relayer to re-check the pending proof
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param messageId messageId that will be used to get the block info from hyperlane
   */
  async getProofs([
    target,
    storageKey,
    messageId,
  ]: ethers.utils.Result): Promise<Array<[string[], string[]]>> {
    const proofs: Array<[string[], string[]]> = [];
    try {
      const { blockNumber, timestamp } =
        await this.hyperlaneService.getOriginBlockByMessageId(messageId);
      const slot = await this.lightClientService.calculateSlot(timestamp);
      // Request Proof from Succinct
      console.log(`Requesting proof for${slot}`);
      // await this.lightClientService.requestProof(syncCommitteePoseidon, slot);

      const { accountProof, storageProof }: ProofResult =
        await this.rpcService.getProofs(
          target,
          [storageKey],
          blockNumber.toString(16), // Converts to hexstring
        );
      proofs.push([accountProof, storageProof[0].proof]);
    } catch (e) {
      console.log('Error getting proofs', e);
    }

    return proofs;
  }
}

export { ProofsService };
