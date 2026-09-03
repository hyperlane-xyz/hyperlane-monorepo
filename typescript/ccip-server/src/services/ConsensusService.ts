export class ConsensusService {
  constructor(private readonly consensusApiUrl: string) {}

  async getOriginBlockNumberBySlot(slot: string): Promise<number> {
    const response = await fetch(`${this.consensusApiUrl}/${slot}`);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch slot ${slot} from consensus API: ${response.statusText}`,
      );
    }
    const responseAsJson = (await response.json()) as any;

    return Number(responseAsJson.data.message.body.execution_payload.block_number);
  }
}
