import { ethers, utils } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi.js';

import { ProofStatus } from './common/ProofStatusEnum.js';

export type SuccinctConfig = {
  readonly lightClientAddress: string;
  readonly stepFunctionId: string;
  readonly platformUrl: string;
  readonly apiKey: string;
};

// Service that interacts with the LightClient/ISM
class LightClientService {
  constructor(
    private readonly lightClientContract: ethers.Contract, // TODO USE TYPECHAIN
    private succinctConfig: SuccinctConfig,
  ) {}

  private getSyncCommitteePeriod(slot: bigint): bigint {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  getSyncCommitteePoseidons(slot: bigint): Promise<string> {
    return this.lightClientContract.syncCommitteePoseidons(
      this.getSyncCommitteePeriod(slot),
    );
  }

  /**
   * Calculates the slot given a timestamp, and the LightClient's configured Genesis Time and Seconds Per Slot
   * @param timestamp timestamp to calculate slot with
   */
  async calculateSlot(timestamp: bigint): Promise<bigint> {
    return (
      (timestamp - (await this.lightClientContract.GENESIS_TIME())) /
      (await this.lightClientContract.SECONDS_PER_SLOT())
    );
  }

  /**
   * Request the proof from Succinct.
   * @param slot
   * @param syncCommitteePoseidon
   */
  async requestProof(
    syncCommitteePoseidon: string,
    slot: bigint,
  ): Promise<string> {
    console.log(`Requesting proof for${slot}`);

    // Note that Succinct will asynchronously call step() on the ISM/LightClient
    const telepathyIface = new utils.Interface(TelepathyCcipReadIsmAbi);

    const body = {
      chainId: this.lightClientContract.chainId,
      to: this.lightClientContract.address,
      data: telepathyIface.encodeFunctionData('step', [slot]),
      functionId: this.lightClientContract.stepFunctionId,
      input: utils.defaultAbiCoder.encode(
        ['bytes32', 'uint64'],
        [syncCommitteePoseidon, slot],
      ),
      retry: true,
    };

    const response = await fetch(
      `${this.lightClientContract.platformUrl}/new`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.succinctConfig.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );
    const responseAsJson = await response.json();

    return responseAsJson.proof_id;
  }

  // @dev in the case of when a proof doesn't exist, the request returns an object of { error: 'failed to get proof' }.
  // Example: GET https://alpha.succinct.xyz/api/proof/4dfd2802-4edf-4c4f-91db-b2d05eb69791
  async getProofStatus(proofId: string): Promise<ProofStatus> {
    const response = await fetch(
      `${this.lightClientContract.platformUrl}/${proofId}`,
    );
    const responseAsJson = await response.json();
    return responseAsJson.status ?? ProofStatus.error;
  }
}

export { LightClientService, ProofStatus };
