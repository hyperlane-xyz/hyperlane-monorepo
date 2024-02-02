// @ts-nocheck
import axios from 'axios';
import { ethers, utils } from 'ethers';

import { TelepathyCcipReadIsmAbi } from '../abis/TelepathyCcipReadIsmAbi';

import { Requestor } from './common/Requestor';

enum ProofStatus {
  running = 'running',
  success = 'success',
}

// Service that interacts with the LightClient/ISM
class LightClientService extends Requestor {
  // Stores the current ProofId that is being generated. Clears once proof is ready.
  pendingProofId: string;

  constructor(
    private readonly lightClientContract: ethers.Contract,
    private readonly stepFunctionId: string,
    private readonly chainId: string,
    readonly platformUrl: string,
    readonly platformApiKey: string,
  ) {
    super(axios, platformApiKey);
  }

  private getSyncCommitteePeriod(slot: bigint): bigint {
    return slot / 8192n; // Slots Per Period
  }

  /**
   * Gets syncCommitteePoseidons from ISM/LightClient
   * @param slot
   * @returns
   */
  getSyncCommitteePoseidons = async (slot: bignumber): Promise<string> => {
    console.log(lightClientContract);
    return await this.lightClientContract.syncCommitteePoseidons(
      this.getSyncCommitteePeriod(slot),
    );
  };

  /**
   * Request the proof from Succinct.
   * @param slot
   * @param syncCommitteePoseidon
   */
  requestProof = async (syncCommitteePoseidon: string, slot: bignumber) => {
    if (!this.pendingProofId) {
      // Request a Proof, set pendingProofId
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
      this.pendingProofId = results.proof_id;

      // Proof is being generated. Force the Relayer to re-check.
      throw new Error('Proof is not ready');
    } else {
      // Proof is being generated, check status
      const proofResults: { status: ProofStatus } = await this.get(
        `${this.platformUrl}/${this.pendingProofId}`,
      );
      if (proofResults.status === ProofStatus.success) {
        // Proof is ready, clear pendingProofId
        this.pendingProofId = null;
      }
      // Proof is not ready. Force the Relayer to re-check.
      throw new Error('Proof is not ready');
    }
  };
}

export { LightClientService, ProofStatus };
