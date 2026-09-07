import { ethers } from 'ethers';
import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { ProofsServiceAbi } from '../abis/ProofsServiceAbi.js';
import { BaseService, ServiceConfig } from './BaseService.js';
import { ConsensusService } from './ConsensusService.js';
import { ProofResult, RPCService } from './RPCService.js';

const EnvSchema = z.object({
  RPC_ADDRESS: z.string().url(),
  CONSENSUS_API_URL: z.string().url(),
});

export class ProofsService extends BaseService {
  public readonly router: Router;
  public rpcService: RPCService;
  public consensusService: ConsensusService;

  static async create(serviceName: string): Promise<ProofsService> {
    return new ProofsService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);
    const env = EnvSchema.parse(process.env);
    this.rpcService = new RPCService(env.RPC_ADDRESS);
    this.consensusService = new ConsensusService(env.CONSENSUS_API_URL);
    this.router = Router();

    const proofsInterface = new ethers.utils.Interface(ProofsServiceAbi);

    const abiHandler = async (req: Request, res: Response) => {
      const handlerLogger = req.log;
      try {
        const body = req.body || {};
        const callData: string =
          (body.data as string) ||
          (req.params?.callData as string) ||
          (req.query?.callData as string) ||
          '';

        if (!callData) {
          return res.status(400).json({ error: 'Missing callData' });
        }

        const decoded = proofsInterface.decodeFunctionData(
          'getProofs',
          callData,
        );
        const target: string = decoded[0];
        const storageKey: string = decoded[1];
        const slot: string = decoded[2].toString();

        handlerLogger?.info(
          { target, storageKey, slot },
          'Fetching proofs from consensus and RPC',
        );

        const proofs = await this.getProofs(target, storageKey, slot);
        const encoded = proofsInterface.encodeFunctionResult('getProofs', [
          proofs,
        ]);
        return res.json({ data: encoded });
      } catch (err: any) {
        handlerLogger?.error({ error: err.message }, 'Error in ProofsService');
        return res.status(500).json({ error: err.message });
      }
    };

    this.router.get('/getProofs/:sender/:callData.json', abiHandler);
    this.router.get('/:sender/:callData.json', abiHandler);
    this.router.post('/', abiHandler);
  }

  /**
   * Requests the account and storage proofs for a given storage key and slot
   * @param target contract address to get the proof for
   * @param storageKey storage key to get the proof for
   * @param slot slot that will be used to get the block info from Consensus API
   * @returns The account proof and single storage proof as [accountProof, storageProof]
   */
  async getProofs(
    target: string,
    storageKey: string,
    slot: string,
  ): Promise<[string[], string[]]> {
    const blockNumber =
      await this.consensusService.getOriginBlockNumberBySlot(slot);
    const { accountProof, storageProof }: ProofResult =
      await this.rpcService.getProofs(
        target,
        [storageKey],
        `0x${blockNumber.toString(16)}`,
      );
    return [accountProof, storageProof[0].proof];
  }
}
