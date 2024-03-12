import { log } from 'console';
import { BigNumber, ethers, utils } from 'ethers';

import {
  ILightClient,
  ILightClient__factory,
} from '../../../../solidity/types';
import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { ProofStatus } from './constants/ProofStatusEnum';

type SuccinctConfig = {
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

  /**
   * Calculates period, given a slot
   * @dev Src: https://github.com/succinctlabs/telepathyx/blob/main/src/operatorx/operator.ts#L20-L22
   * @param slot
   */
  async getSyncCommitteePeriod(slot: BigNumber): Promise<BigNumber> {
    return slot.div(await this.lightClientContract.SLOTS_PER_PERIOD());
  }

  /**
   * Calculates the sync committee poseidon from the LightClient, given a slot
   * @param slot
   */
  async getSyncCommitteePoseidons(slot: BigNumber): Promise<string> {
    return await this.lightClientContract.syncCommitteePoseidons(
      await this.getSyncCommitteePeriod(slot),
    );
  }

  /**
   * Calculates the slot, given a timestamp, and the LightClient's configured Genesis Time and Secods Per Slot
   * @param timestamp timestamp to calculate slot with
   */
  async calculateSlot(timestamp: BigNumber): Promise<BigNumber> {
    const genesisTime = await this.lightClientContract.GENESIS_TIME();
    const secondsPerSlot = await this.lightClientContract.SECONDS_PER_SLOT();
    return timestamp.sub(genesisTime).div(secondsPerSlot);
  }

  /**
   * Request the ZK proof from Succinct, given the sync committee poseidon, and a slot
   * @param slot
   * @param syncCommitteePoseidon
   * @returns proof_id from succinct
   */
  async requestProof(
    syncCommitteePoseidon: string,
    slot: BigNumber,
  ): Promise<string> {
    log(`Requesting ZK proof for ${slot}`);

    const telepathyIface = new utils.Interface(TelepathyCcipReadIsmAbi);

    const body = {
      chainId: this.succinctConfig.chainId,
      to: this.lightClientContract.address,
      data: telepathyIface.encodeFunctionData('step', [slot]), // Tells Succinct to asynchronously call step() on the LightClient after the proof generation
      input: utils.defaultAbiCoder.encode(
        ['bytes32', 'uint64'],
        [syncCommitteePoseidon, slot],
      ),
      functionId: this.succinctConfig.stepFunctionId,
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

  /**
   * Check on the status of the ZK proof from Succinct.
   * @param proofId
   */
  async getProofStatus(proofId: string): Promise<ProofStatus> {
    const response = await fetch(
      `${this.succinctConfig.platformUrl}/${proofId}`,
    );
    const responseAsJson = await response.json();
    // @dev in the case of when a proof doesn't exist, the request returns an object of { error: 'failed to get proof' }.
    // Example: GET https://alpha.succinct.xyz/api/proof/4dfd2802-4edf-4c4f-91db-b2d05eb69791
    return responseAsJson.status ?? ProofStatus.error;
  }
}

export { LightClientService, ProofStatus, SuccinctConfig };
