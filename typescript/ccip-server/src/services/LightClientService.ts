import axios from 'axios';
import { ethers, utils } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

class LightClientService {
  constructor(
    private readonly lightClient: ethers.Contract,
    private readonly stepFunctionId: string,
    private readonly chainId: string,
    private readonly platformUrl: string,
    private readonly platformApiKey: string,
  ) {}

  private getSyncCommitteePeriod(slot: bigint): bigint {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  getSyncCommitteePoseidons = async (slot: bigint): Promise<any> => {
    return await this.lightClient.syncCommitteePoseidons(
      this.getSyncCommitteePeriod(slot),
    );
  };

  /**
   * Request the proof from Succinct
   * @param slot
   * @param syncCommitteePoseidon
   */
  requestProof = async (slot: bigint, syncCommitteePoseidon: bigint) => {
    const telepathyIface = new utils.Interface(TelepathyCcipReadIsmAbi);
    const body = {
      chainId: this.chainId,
      to: this.lightClient.address,
      data: telepathyIface.encodeFunctionData('step', [slot]),
      functionId: this.stepFunctionId,
      input: utils.defaultAbiCoder.encode(
        ['bytes32', 'uint64'],
        [syncCommitteePoseidon, slot],
      ),
      retry: true,
    };

    await axios.post(this.platformUrl, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.platformApiKey}`,
      },
      body, // body data type must match "Content-Type" header
    });

    // If the proof is not ready, return 404 so Relayer retries
  };
}

export { LightClientService };
