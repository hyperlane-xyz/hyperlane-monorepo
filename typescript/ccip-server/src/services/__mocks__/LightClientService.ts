import { BigNumber } from 'ethers';

enum ProofStatus {
  running = 'running',
  success = 'success',
  error = 'error',
}

export const genesisTime = 1606824023;
export const slotsPerSecond = 12;

class LightClientService {
  proofStatus: ProofStatus = ProofStatus.running;
  async calculateSlot(timestamp: BigNumber): Promise<BigNumber> {
    return timestamp
      .sub(BigNumber.from(genesisTime))
      .div(BigNumber.from(slotsPerSecond)); // (timestamp - GENESIS TIME) / SLOTS_PER_SECOND
  }

  async requestProof(
    syncCommitteePoseidon: string,
    slot: BigNumber,
  ): Promise<string> {
    return 'pendingProofId12';
  }

  async getProofStatus(pendingProofId: string): Promise<ProofStatus> {
    return ProofStatus.success;
  }
}

export { LightClientService };
