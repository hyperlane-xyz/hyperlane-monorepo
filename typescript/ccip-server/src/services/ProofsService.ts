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
   * @param address contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param block block to get the proof for. Will decode as a BigNumber.
   * @returns
   */
  async getProofs([address, storageKeys, block]: ethers.utils.Result): Promise<
    Array<[string[], string[]]>
  > {
    // TODO fix any
    // Gets the sync committee poseidon associated with the slot
    // const slot = 0n; // TODO figure out which slot to use
    // @ts-ignore
    // const syncCommitteePoseidon =
    //   await this.lightClientService.getSyncCommitteePoseidons(slot);

    // No Sync committee poseidon for this slot, return empty proof
    // if (syncCommitteePoseidon == constants.HashZero) return constants.HashZero;

    // await this.lightClientService.requestProof(syncCommitteePoseidon, slot);
    const { accountProof, storageProof }: ProofResult =
      await this.rpcService.getProofs(
        address,
        storageKeys,
        block.toHexString(),
      );

    return [[accountProof, storageProof[0].proof]];
  }
}

export { ProofsService };
