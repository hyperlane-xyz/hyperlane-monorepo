export class ConsensusService {
  constructor(private readonly consensusApiUrl: string) {}
  async getOriginBlockNumberBySlot(slot: string): Promise<number> {
    const response = await fetch(`${this.consensusApiUrl}/${slot}`);
    const responseAsJson = await response.json();

    return responseAsJson.data.message.body.execution_payload.block_number;
  }
}
