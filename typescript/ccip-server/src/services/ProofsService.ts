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
  pendingProof = new Map<string, string>();

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
    const pendingProofKey = this.getPendingProofKey(
      target,
      storageKey,
      messageId,
    );
    if (!this.pendingProof.has(pendingProofKey)) {
      // Request a Proof from Succinct
      const { timestamp } =
        await this.hyperlaneService.getOriginBlockByMessageId(messageId);
      const slot = await this.lightClientService.calculateSlot(timestamp);
      const syncCommitteePoseidon = ''; // TODO get prof LC
      const pendingProofId = await this.lightClientService.requestProof(
        syncCommitteePoseidon,
        slot,
      );

      this.pendingProof.set(pendingProofKey, pendingProofId);

      this.forceRelayerRecheck();
    } else {
      // Proof is being generated, check status
      const proofStatus = await this.lightClientService.getProofStatus(
        this.pendingProof.get(pendingProofKey)!,
      );
      if (proofStatus === ProofStatus.success) {
        // Proof is ready, clear pendingProofId from Mapping
        this.pendingProof.delete(pendingProofKey);
      }

      // Proof still not ready
      this.forceRelayerRecheck();
    }
    return proofs;
  }

  getPendingProofKey(
    target: string,
    storageKey: string,
    messageId: string,
  ): string {
    return ethers.utils.defaultAbiCoder.encode(
      ['string', 'string', 'string'],
      [target, storageKey, messageId],
    );
  }

  forceRelayerRecheck(): void {
    throw new Error('Proof is not ready');
  }
}

export { ProofsService };
