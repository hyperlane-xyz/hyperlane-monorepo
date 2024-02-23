// @ts-nocheck
import axios from 'axios';
import { ethers, utils } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { Requestor } from './common/Requestor';

export enum ProofStatus {
  running = 'running',
  success = 'success',
  error = 'error',
}

export type SuccinctConfig = {
  readonly lightClientAddress: string;
  readonly stepFunctionId: string;
  readonly platformUrl: string;
  readonly apiKey: string;
};

// Service that interacts with the LightClient/ISM
class LightClientService extends Requestor {
  // Stores the current ProofId that is being generated. Clears once proof is ready.
  pendingProofId: string;

  constructor(
    private readonly lightClientContract: ethers.Contract, // TODO USE TYPECHAIN
    succinctConfig: SuccinctConfig,
  ) {
    super(axios, succinctConfig.apiKey);
  }

  private getSyncCommitteePeriod(slot: BigInt): BigInt {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  async getSyncCommitteePoseidons(slot: BigInt): Promise<string> {
    return await this.lightClientContract.syncCommitteePoseidons(
      this.getSyncCommitteePeriod(slot),
    );
  }

  /**
   * Calculates the slot given a timestamp, and the LightClient's configured Genesis Time and Secods Per Slot
   * @param timestamp timestamp to calculate slot with
   */
  async calculateSlot(timestamp: number): Promise<BigInt> {
    return (
      (timestamp - (await this.lightClientContract.GENESIS_TIME)) /
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
    slot: BigInt,
  ): Promise<string> {
    console.log(`Requesting proof for${slot}`);

    // Note that Succinct will asynchronously call step() on the ISM/LightClient
    const telepathyIface = new utils.Interface(TelepathyCcipReadIsmAbi);

    const body = {
      chainId: this.chainId,
      to: this.lightClientContract.address,
      data: telepathyIface.encodeFunctionData('step', [slot]),
      functionId: this.stepFunctionId,
      input: utils.defaultAbiCoder.encode(
        ['bytes32', 'uint64'],
        [syncCommitteePoseidon, slot],
      ),
      retry: true,
    };

    const results: { proof_id: string } = await this.postWithAuthorization(
      `${this.platformUrl}/new`,
      body,
    );

    return results.proof_id;
  }

  // @dev in the case of when a proof doesn't exist, the request returns an object of { error: 'failed to get proof' }.
  // Example: GET https://alpha.succinct.xyz/api/proof/4dfd2802-4edf-4c4f-91db-b2d05eb69791
  async getProofStatus(proofId: string): Promise<ProofStatus> {
    const results = this.get(`${this.platformUrl}/${proofId}`);
    return results.status ?? ProofStatus.error;
  }
}

export { LightClientService, ProofStatus };
