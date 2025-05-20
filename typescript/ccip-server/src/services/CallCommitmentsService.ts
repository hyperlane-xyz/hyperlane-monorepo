import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  HyperlaneCore,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import { CallCommitmentsAbi } from '../abis/CallCommitmentsAbi.js';
import { prisma } from '../db.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService } from './BaseService.js';

const postCallsSchema = z.object({
  calls: z
    .array(
      z.object({
        to: z.string(),
        data: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(1),
  relayers: z.array(z.string()).min(0),
  salt: z.string(),
  ica: z.string(),
  commitmentDispatchTx: z.string(),
  originDomain: z.number(),
});

// TODO: Authenticate relayer
export class CallCommitmentsService extends BaseService {
  constructor(
    private multiProvider: MultiProvider,
    private core: HyperlaneCore,
  ) {
    super();
    this.registerRoutes(this.router);
  }

  static async initialize() {
    const registryUris = process.env.REGISTRY_URI?.split(',') || [
      DEFAULT_GITHUB_REGISTRY,
    ];
    console.log('Using registry URIs', registryUris);
    const registry = getRegistry({
      registryUris: registryUris,
      enableProxy: true,
    });
    const metadata = await registry.getMetadata();
    const multiProvider = new MultiProvider({ ...metadata });
    const chainAddresses = await registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
    return new CallCommitmentsService(multiProvider, core);
  }

  public async handleCommitment(req: Request, res: Response) {
    const data = this.parseCommitmentBody(req.body, res);
    if (!data) return;

    const commitment = commitmentFromIcaCalls(
      normalizeCalls(data.calls),
      data.salt,
    );
    try {
      await this.validateCommitmentDispatched(data, commitment);
    } catch (error: any) {
      console.error('Commitment dispatch validation failed', commitment, error);
      return res.status(400).json({ error: error.message });
    }

    await this.insertCommitmentToDB(commitment, data);
    res.sendStatus(200);
    return;
  }

  public async handleFetchCommitment(commitment: string) {
    try {
      const record = await this.fetchCommitmentRecord(commitment);
      const encoded =
        record.ica +
        encodeIcaCalls(normalizeCalls(record.calls as any), record.salt).slice(
          2,
        );
      console.log('Serving calls for commitment', commitment);
      return encoded;
    } catch (error: any) {
      console.error('Error fetching commitment', commitment, error);
      return JSON.stringify({ error: error.message });
    }
  }

  /**
   * Validate and parse the request body against the Zod schema.
   * Returns parsed data or sends a 400 response and returns null.
   */
  private parseCommitmentBody(body: any, res: Response) {
    const result = postCallsSchema.safeParse(body);
    if (!result.success) {
      console.log('Invalid request', result.error.flatten().fieldErrors);
      res.status(400).json({ errors: result.error.flatten().fieldErrors });
      return null;
    }
    return result.data;
  }

  /**
   * Insert a new commitment record into the database.
   */
  private async insertCommitmentToDB(
    commitment: string,
    data: z.infer<typeof postCallsSchema>,
  ) {
    const { calls, relayers, salt, ica, commitmentDispatchTx, originDomain } =
      data;
    await prisma.commitment.create({
      data: {
        id: commitment,
        calls,
        relayers,
        salt,
        ica,
        commitmentDispatchTx,
        originDomain,
      },
    });
    console.log('Stored commitment', commitment);
  }

  /**
   * Fetch a commitment record from the database by ID.
   * Throws if not found.
   */
  private async fetchCommitmentRecord(id: string) {
    const record = await prisma.commitment.findUnique({ where: { id } });
    if (!record) {
      console.log('Commitment not found in DB', id);
      throw new Error('Commitment not found');
    }
    return record;
  }

  /**
   * Ensure the commitment was dispatched on-chain; throws if not.
   */
  private async validateCommitmentDispatched(
    data: z.infer<typeof postCallsSchema>,
    commitment: string,
  ): Promise<void> {
    const provider = this.multiProvider.getProvider(data.originDomain);
    const tx = await provider.getTransactionReceipt(data.commitmentDispatchTx);
    const dispatchedMessages = this.core.getDispatchedMessages(tx);
    const wasCommitmentDispatched = dispatchedMessages.some((message) =>
      message.parsed.body
        .toLowerCase()
        .includes(commitment.slice(2).toLowerCase()),
    );
    if (!wasCommitmentDispatched) {
      throw new Error('Commitment not dispatched');
    }
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router): void {
    router.post('/calls_mock', async (req, res) => {
      const data = this.parseCommitmentBody(req.body, res);
      if (!data) return;

      const commitment = crypto.randomUUID().toString();

      await this.insertCommitmentToDB(commitment, data);
      res.status(200).send({ commitment: commitment });
      return;
    });

    router.post('/calls', this.handleCommitment.bind(this));
    router.post(
      '/getCallsFromCommitment',
      createAbiHandler(
        CallCommitmentsAbi,
        'getCallsFromCommitment',
        this.handleFetchCommitment.bind(this),
        true, // Skip ABI encoding of the result
      ),
    );
  }
}
