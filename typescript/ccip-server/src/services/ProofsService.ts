import { ethers } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { LightClientService } from './LightClientService';
import { ProofResult, RPCService } from './RPCService';
import { HandlerDescriptionEnumerated } from './common/HandlerDescriptionEnumerated';

// Service that requests proofs from Succinct and RPC Provider
class ProofsService extends HandlerDescriptionEnumerated {
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
  }

  /**
   * Requests the Succinct proof, state proof, and returns account and storage proof
   * @dev Note that the abi encoding will happen within ccip-read-server
   * @param target contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param blockNumber block to get the proof for. Will decode as a BigInteger.
   * @returns
   */
  async getProofs([
    address,
    storageKey,
    blockNumber,
  ]: ethers.utils.Result): Promise<Array<[string[], string[]]>> {
    const proofs: Array<[string[], string[]]> = [];
    try {
      // TODO Implement request Proof from Succinct
      // await this.lightClientService.requestProof(syncCommitteePoseidon, slot);

      // Get storage proofs
      const { accountProof, storageProof }: ProofResult =
        await this.rpcService.getProofs(
          address,
          [storageKey],
          blockNumber.toHexString(),
        );
      proofs.push([accountProof, storageProof[0].proof]);
    } catch (e) {
      console.log('Error getting proofs', e);
    }

    return proofs;
  }
}

export { ProofsService };
