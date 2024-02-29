// TODO figure out why I cannot import this from LightClientService.
enum ProofStatus {
  running = 'running',
  success = 'success',
  error = 'error',
}

class LightClientService {
  proofStatus: ProofStatus = ProofStatus.running;
  async calculateSlot(timestamp: bigint): Promise<bigint> {
    return (
      (timestamp - 1606824023n) / 12n // (timestamp - GENESIS TIME) / SLOTS_PER_SECOND
    );
  }

  async requestProof(
    syncCommitteePoseidon: string,
    slot: BigInt,
  ): Promise<string> {
    return 'pendingProofId12';
  }
  async getProofStatus(pendingProofId: string): Promise<ProofStatus> {
    return ProofStatus.success;
  }
}

export { LightClientService };
