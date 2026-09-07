import { BytesLike, ethers, providers } from 'ethers';
import { Request, Response, Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { BaseService, ServiceConfig } from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';
import { RPCService, ProofResult } from './RPCService.js';

const EnvSchema = z.object({
  RPC_ADDRESS: z.string().url().default('http://localhost:8545'),
  CHAIN_ID: z.string().default('1'),
  HYPERLANE_EXPLORER_API: z.string().url().optional(),
  TELEPATHY_API_URL: z.string().url().default('https://alpha.succinct.xyz/api'),
  MAILBOX_ADDRESS: z.string().optional(),
  ORIGIN_DOMAIN: z.string().default('1'),
});

export interface TelepathyProofPayload {
  slot: number;
  origin_mailbox?: string;
  storage_key: string;
  account_proof: string[];
  storage_proof: string[];
  expected_value?: string;
}

export class TelepathyService extends BaseService {
  public readonly router: Router;
  private provider: providers.JsonRpcProvider;
  private rpcService: RPCService;
  private hyperlaneService?: HyperlaneService;
  private defaultMailboxAddress?: string;
  private originDomain: number;
  private telepathyApiUrl: string;

  static async create(serviceName: string): Promise<TelepathyService> {
    return new TelepathyService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);
    const env = EnvSchema.parse(process.env);

    this.provider = new providers.JsonRpcProvider(env.RPC_ADDRESS);
    this.rpcService = new RPCService(env.RPC_ADDRESS);
    this.defaultMailboxAddress = env.MAILBOX_ADDRESS;
    this.originDomain = parseInt(env.ORIGIN_DOMAIN, 10);
    this.telepathyApiUrl = env.TELEPATHY_API_URL;

    if (env.HYPERLANE_EXPLORER_API) {
      this.hyperlaneService = new HyperlaneService(
        this.config.serviceName,
        env.HYPERLANE_EXPLORER_API,
      );
    }

    this.router = Router();

    // CCIP-read standard: GET /getProof/:sender/:callData.json
    this.router.get(
      '/getProof/:sender/:callData.json',
      this.handleGetProof.bind(this),
    );

    // CCIP-read standard: POST /getProof
    this.router.post('/getProof', this.handlePostProof.bind(this));

    // Direct REST endpoints
    this.router.get(
      '/fetchProof/:messageId',
      this.handleFetchProofById.bind(this),
    );
    this.router.post('/fetchProof', this.handleFetchProof.bind(this));
    this.router.post(
      '/getProofForMessage',
      this.handleGetProofForMessage.bind(this),
    );
  }

  /**
   * Calculates the Ethereum beacon slot for a given block timestamp.
   * Ethereum mainnet genesis timestamp: 1606824120
   */
  public calculateBeaconSlot(timestamp: number): number {
    const GENESIS_TIME = 1606824120;
    const SECONDS_PER_SLOT = 12;
    if (timestamp < GENESIS_TIME) {
      return 0;
    }
    return Math.floor((timestamp - GENESIS_TIME) / SECONDS_PER_SLOT);
  }

  /**
   * Derives storage slot key for a message leaf or message ID in origin Mailbox contract
   */
  public getMessageStorageKey(messageId: string, index?: number): string {
    if (index !== undefined) {
      // Merkle tree tree leaf slot calculation
      const leafSlot = 4; // Standard storage slot of tree in MerkleTreeHook
      return ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'uint256'],
          [index, leafSlot],
        ),
      );
    }
    // Direct message ID mapping storage key
    const mappingSlot = 0;
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'uint256'],
        [messageId, mappingSlot],
      ),
    );
  }

  /**
   * Fetches state and storage proofs via eth_getProof
   */
  public async getProofForMessage(
    messageHex: string,
    mailboxAddressOverride?: string,
    blockNumberOverride?: number | string,
    logger?: Logger,
  ): Promise<TelepathyProofPayload> {
    const rawBytes = ethers.utils.arrayify(messageHex);
    const messageId = ethers.utils.keccak256(rawBytes);

    logger?.info({ messageId }, 'Generating Telepathy proof for message');

    let blockNumber = blockNumberOverride;
    let mailboxAddress = mailboxAddressOverride || this.defaultMailboxAddress;

    // If block number is not provided, try resolving from Hyperlane Explorer or latest block
    if (!blockNumber && this.hyperlaneService) {
      try {
        const txHash =
          await this.hyperlaneService.getOriginTransactionHashByMessageId(
            messageId,
            logger as Logger,
          );
        if (txHash) {
          const receipt = await this.provider.getTransactionReceipt(txHash);
          if (receipt) {
            blockNumber = receipt.blockNumber;
            if (!mailboxAddress && receipt.to) {
              mailboxAddress = receipt.to;
            }
          }
        }
      } catch (err: any) {
        logger?.warn(
          { error: err.message },
          'Could not lookup message in explorer, falling back to latest block',
        );
      }
    }

    if (!blockNumber) {
      blockNumber = await this.provider.getBlockNumber();
    }

    if (!mailboxAddress) {
      mailboxAddress = '0x0000000000000000000000000000000000000001';
    }

    const block = await this.provider.getBlock(blockNumber);
    const slot = this.calculateBeaconSlot(block.timestamp);

    const storageKey = this.getMessageStorageKey(messageId);
    const blockTag =
      typeof blockNumber === 'number'
        ? ethers.utils.hexValue(blockNumber)
        : blockNumber;

    const proofResult: ProofResult = await this.rpcService.getProofs(
      mailboxAddress,
      [storageKey],
      blockTag,
    );

    const storageProofNodes = proofResult.storageProof[0]?.proof || [];
    const storageValue = proofResult.storageProof[0]?.value || messageId;

    return {
      slot,
      origin_mailbox: mailboxAddress,
      storage_key: storageKey,
      account_proof: proofResult.accountProof,
      storage_proof: storageProofNodes,
      expected_value: storageValue,
    };
  }

  private async handleGetProof(req: Request, res: Response) {
    const logger = req.log || console;
    try {
      const { sender, callData } = req.params;
      const cleanCallData = (callData || '').replace(/\.json$/, '');
      const payload = await this.getProofForMessage(
        cleanCallData,
        sender,
        undefined,
        logger as Logger,
      );
      return res.json({ data: payload });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  private async handlePostProof(req: Request, res: Response) {
    const logger = req.log || console;
    try {
      const { sender, data } = req.body || {};
      const payload = await this.getProofForMessage(
        data,
        sender,
        undefined,
        logger as Logger,
      );
      return res.json({ data: payload });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  private async handleFetchProofById(req: Request, res: Response) {
    const logger = req.log || console;
    try {
      const { messageId } = req.params;
      const payload = await this.getProofForMessage(
        messageId,
        req.query.mailbox as string,
        req.query.block as string,
        logger as Logger,
      );
      return res.json({ data: payload });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  private async handleFetchProof(req: Request, res: Response) {
    const logger = req.log || console;
    try {
      const { message, mailbox, blockNumber } = req.body || {};
      const payload = await this.getProofForMessage(
        message,
        mailbox,
        blockNumber,
        logger as Logger,
      );
      return res.json({ data: payload });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  private async handleGetProofForMessage(req: Request, res: Response) {
    const logger = req.log || console;
    try {
      const { message, mailboxAddress, blockNumber } = req.body || {};
      const payload = await this.getProofForMessage(
        message,
        mailboxAddress,
        blockNumber,
        logger as Logger,
      );
      return res.json(payload);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
}
