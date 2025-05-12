import { ethers } from 'ethers';
import { Router } from 'express';

import { ProofsServiceAbi } from '../abis/ProofsServiceAbi';
import { createAbiHandler } from '../utils/abiHandler';

import { HyperlaneService } from './HyperlaneService';
import { LightClientService, SuccinctConfig } from './LightClientService';
import { ProofResult, RPCService } from './RPCService';
import { ProofStatus } from './common/ProofStatusEnum';

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

  public readonly router: Router;

  constructor() {
    // Load module config from ENV
    const lightClientAddress = process.env.SUCCINCT_LIGHT_CLIENT_ADDRESS;
    const succinctTrustRoot = process.env.SUCCINCT_TRUST_ROOT;
    const rpcUrl = process.env.PROOFS_RPC_URL;
    const rpcChainId = process.env.PROOFS_CHAIN_ID;
    const hyperlaneUrl = process.env.HYPERLANE_URL;
    if (
      !lightClientAddress ||
      !succinctTrustRoot ||
      !rpcUrl ||
      !rpcChainId ||
      !hyperlaneUrl
    ) {
      throw new Error('Missing required ProofsService environment variables');
    }
    const succinctConfig = {
      lightClientAddress,
      trustRoot: succinctTrustRoot,
    } as Required<SuccinctConfig>;
    const rpcConfig = {
      url: rpcUrl,
      chainId: rpcChainId,
    } as Required<RPCConfig>;
    const hyperlaneConfig = { url: hyperlaneUrl } as Required<HyperlaneConfig>;

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
    this.router = Router();

    // CCIP-read spec: GET /getProofs/:sender/:callData.json
    this.router.get(
      '/getProofs/:sender/:callData.json',
      createAbiHandler(
        ProofsServiceAbi,
        'getProofs',
        this.getProofs.bind(this),
      ),
    );

    // CCIP-read spec: POST /getProofs
    this.router.post(
      '/getProofs',
      createAbiHandler(
        ProofsServiceAbi,
        'getProofs',
        this.getProofs.bind(this),
      ),
    );
  }

  /**
   * Requests the Succinct proof, state proof, and returns account and storage proof
   * @dev Upon requesting Succinct Proof, this function will revert to force the relayer to re-check the pending proof
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param messageId messageId that will be used to get the block info from hyperlane
   * @returns The account and a single storage proof
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
      const pendingProofId = await this.requestProofFromSuccinct(messageId);
      this.pendingProof.set(pendingProofKey, pendingProofId);
      this.forceRelayerRecheck();
    } else {
      // Proof is being generated, check status
      const proofStatus = await this.lightClientService.getProofStatus(
        this.pendingProof.get(pendingProofKey)!,
      );
      if (proofStatus === ProofStatus.success) {
        // Succinct Proof is ready.
        // This means that the LightClient should have the latest state root. Fetch and return the storage proofs from eth_getProof
        proofs.push(await this.getStorageProofs(target, storageKey, messageId));
        this.pendingProof.delete(pendingProofKey);
      } else {
        this.forceRelayerRecheck();
      }
    }
    // TODO Write tests to check proofs
    return proofs;
  }

  /**
   * Requests the Succinct proof
   * @param messageId messageId that will be used to get the block info from hyperlane
   * @returns the proofId
   */
  async requestProofFromSuccinct(messageId: string) {
    const { timestamp } =
      await this.hyperlaneService.getOriginBlockByMessageId(messageId);
    const slot = await this.lightClientService.calculateSlot(BigInt(timestamp));
    const syncCommitteePoseidon = ''; // TODO get from LC
    return this.lightClientService.requestProof(syncCommitteePoseidon, slot);
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param messageId messageId that will be used to get the block info from hyperlane
   * @returns The account and a single storage proof
   */
  async getStorageProofs(
    target: string,
    storageKey: string,
    messageId: string,
  ): Promise<[string[], string[]]> {
    const { blockNumber } =
      await this.hyperlaneService.getOriginBlockByMessageId(messageId);
    const { accountProof, storageProof }: ProofResult =
      await this.rpcService.getProofs(
        target,
        [storageKey],
        new Number(blockNumber).toString(16), // Converts to hexstring
      );

    return [accountProof, storageProof[0].proof]; // Since we only expect one storage key, we only return the first proof
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
