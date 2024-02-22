import { ethers } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { LightClientService } from './LightClientService';
import { ProofResult, RPCService } from './RPCService';

// Service that requests proofs from Succinct and RPC Provider
class ProofsService {
  rpcService: RPCService;
  lightClientService: LightClientService;

  constructor(
    readonly lightClientAddress: string,
    readonly rpcAddress: string,
    readonly stepFunctionId: string,
    readonly chainId: string,
    readonly succinctPlatformUrl: string,
    readonly succinctPlatformApiKey: string,
  ) {
    this.rpcService = new RPCService(rpcAddress);
    const lightClientContract = new ethers.Contract(
      lightClientAddress,
      TelepathyCcipReadIsmAbi,
      this.rpcService.provider,
    );
    this.lightClientService = new LightClientService(
      lightClientContract,
      stepFunctionId,
      chainId,
      succinctPlatformUrl,
      succinctPlatformApiKey,
    );
  }

  /**
   * Requests the Succinct proof, state proof, and returns account and storage proof
   * @dev Note that the abi encoding will happen within ccip-read-server
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param blockNumber block to get the proof for. Will decode as a BigInt.
   * Note that JS BigInt can only handle 2^53 - 1. For block number, this should be plenty.
   */
  async getProofs([
    address,
    storageKey,
    blockNumber,
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
          address,
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
