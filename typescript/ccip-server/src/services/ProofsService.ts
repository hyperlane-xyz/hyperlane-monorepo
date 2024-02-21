import { error } from 'console';
import { ethers } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { HyperlaneService } from './HyperlaneService';
import { LightClientService } from './LightClientService';
import { ProofResult, RPCService } from './RPCService';
import { HandlerDescriptionEnumerated } from './common/HandlerDescriptionEnumerated';

// Service that requests proofs from Succinct and RPC Provider
class ProofsService extends HandlerDescriptionEnumerated {
  rpcService: RPCService;
  lightClientService: LightClientService;
  hyperlaneService: HyperlaneService;

  constructor(
    readonly lightClientAddress: string,
    readonly rpcAddress: string,
    readonly stepFunctionId: string,
    readonly chainId: string,
    readonly succinctPlatformUrl: string,
    readonly succinctPlatformApiKey: string,
    readonly hyperlaneUrl: string,
  ) {
    super();
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
    this.hyperlaneService = new HyperlaneService(hyperlaneUrl);
  }

  /**
   * Requests the Succinct proof, state proof, and returns account and storage proof
   * @dev Note that the abi encoding will happen within ccip-read-server
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param messageId Id of Message
   * Note that JS BigInt can only handle 2^53 - 1. For block number, this should be plenty.
   */
  async getProofs([
    address,
    storageKey,
    messageId,
  ]: ethers.utils.Result): Promise<Array<[string[], string[]]>> {
    const proofs: Array<[string[], string[]]> = [];
    try {
      // Request Proof from Succinct
      // console.log(`Requesting proof for${slot}`);
      // await this.lightClientService.requestProof(syncCommitteePoseidon, slot);

      const blockNumber =
        await this.hyperlaneService.getOriginBlockNumberByMessageId(messageId);
      const { accountProof, storageProof }: ProofResult =
        await this.rpcService.getProofs(
          address,
          [storageKey],
          new Number(blockNumber).toString(16), // Converts to hexstring
        );
      proofs.push([accountProof, storageProof[0].proof]);
    } catch (e) {
      error('Error getting proofs', e);
    }

    return proofs;
  }
}

export { ProofsService };
