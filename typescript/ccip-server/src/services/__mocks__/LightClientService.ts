// TODO figure out why I cannot import this from LightClientService.
enum ProofStatus {
  running = 'running',
  success = 'success',
  error = 'error',
}

class LightClientService {
  proofStatus: ProofStatus = ProofStatus.running;
  async calculateSlot(timestamp: number): Promise<number> {
    return (
      (timestamp - 1606824023) / 12 // (timestamp - GENESIS TIME) / SLOTS_PER_SECOND
    );
  }

  async requestProof(
    syncCommitteePoseidon: string,
    slot: BigInt,
  ): Promise<string> {
    return 'pendingProofId12';
  }

  async getProofStatus(proofId: string): Promise<ProofStatus> {
    return this.proofStatus;
  }

  async __setProofStatus(proofStatus: ProofStatus): Promise<ProofStatus> {
    return (this.proofStatus = proofStatus);
  }
}

export { LightClientService };
