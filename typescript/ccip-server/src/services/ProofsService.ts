import { ethers } from 'ethers';

import { LightClientService } from './LightClientService';
import { RPCService } from './RPCService';

class ProofsService {
  constructor(
    private readonly rpcService: RPCService,
    private readonly lightClientService: LightClientService,
  ) {}

  /**
   * Gets Succinct proof, state proof, and returns account and storage proof
   * @dev Note that the abi encoding will happen within ccip-read-server
   * @param address contract address to get the proof for
   * @param storageKeys storage keys to get the proof for
   * @param block
   * @returns
   */
  getProofs = async ([
    address,
    storageKeys,
    block,
  ]: ethers.utils.Result): Promise<Array<any>> => {
    // Gets the sync committee poseidon associated with the slot
    const slot = 0n; // TODO figure out which slot to use
    // @ts-ignore
    const syncCommitteePoseidon =
      await this.lightClientService.getSyncCommitteePoseidons(slot);

    // No Sync committee poseidon for this slot, return empty proof
    // if (syncCommitteePoseidon == constants.HashZero) return constants.HashZero;

    // await this.requestProofFromSuccinct(slot, syncCommitteePoseidon);
    const { result } = await this.rpcService.getProofs(
      address,
      storageKeys,
      block,
    );

    return [[result.accountProof, result.storageProof[0].proof]];
  };
}

export { ProofsService };
