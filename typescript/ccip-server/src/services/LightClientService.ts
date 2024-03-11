import { BigNumber, ethers, utils } from 'ethers';

import { ILightClient } from '../../../../solidity/types';
import { ILightClient__factory } from '../../../../solidity/types';
import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { ProofStatus } from './common/ProofStatusEnum';

export type SuccinctConfig = {
  readonly lightClientAddress: string;
  readonly stepFunctionId: string;
  readonly platformUrl: string;
  readonly apiKey: string;
  readonly chainId: string;
};

// Service that interacts with the LightClient/ISM
class LightClientService {
  lightClientContract: ILightClient;

  constructor(
    private succinctConfig: SuccinctConfig,
    provider: ethers.providers.JsonRpcProvider,
  ) {
    this.lightClientContract = ILightClient__factory.connect(
      succinctConfig.lightClientAddress,
      provider,
    );
  }

  private getSyncCommitteePeriod(slot: bigint): bigint {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  async getSyncCommitteePoseidons(slot: bigint): Promise<string> {
    return await this.lightClientContract.syncCommitteePoseidons(
      this.getSyncCommitteePeriod(slot),
    );
  }

  /**
   * Calculates the slot given a timestamp, and the LightClient's configured Genesis Time and Secods Per Slot
   * @param timestamp timestamp to calculate slot with
   */
  async calculateSlot(timestamp: BigNumber): Promise<BigNumber> {
    const genesisTime = await this.lightClientContract.GENESIS_TIME();
    const secondsPerSlot = await this.lightClientContract.SECONDS_PER_SLOT();
    return timestamp.sub(genesisTime).div(secondsPerSlot);
  }

  /**
   * Request the proof from Succinct.
   * @param slot
   * @param syncCommitteePoseidon
   */
  async requestProof(
    syncCommitteePoseidon: string,
    slot: BigNumber,
  ): Promise<string> {
    console.log(`Requesting proof for${slot}`);

    // Note that Succinct will asynchronously call step() on the ISM/LightClient
    const telepathyIface = new utils.Interface(TelepathyCcipReadIsmAbi);

    const body = {
      chainId: this.succinctConfig.chainId,
      to: this.lightClientContract.address,
      data: telepathyIface.encodeFunctionData('step', [slot]),
      functionId: this.succinctConfig.stepFunctionId,
      input: utils.defaultAbiCoder.encode(
        ['bytes32', 'uint64'],
        [syncCommitteePoseidon, slot],
      ),
      retry: true,
    };

    const response = await fetch(`${this.succinctConfig.platformUrl}/new`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.succinctConfig.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const responseAsJson = await response.json();

    return responseAsJson.proof_id;
  }

  // @dev in the case of when a proof doesn't exist, the request returns an object of { error: 'failed to get proof' }.
  // Example: GET https://alpha.succinct.xyz/api/proof/4dfd2802-4edf-4c4f-91db-b2d05eb69791
  async getProofStatus(proofId: string): Promise<ProofStatus> {
    const response = await fetch(
      `${this.succinctConfig.platformUrl}/${proofId}`,
    );
    const responseAsJson = await response.json();
    return responseAsJson.status ?? ProofStatus.error;
  }
}

export { LightClientService, ProofStatus };
