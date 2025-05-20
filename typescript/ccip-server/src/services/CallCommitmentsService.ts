import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { encodeIcaCalls, normalizeCalls } from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { addressToBytes32, bytes32ToAddress } from '@hyperlane-xyz/utils';

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
  commitmentDispatchTx: z.string(),
  originDomain: z.number(),
});

// TODO: Authenticate relayer
export class CallCommitmentsService extends BaseService {
  constructor(private multiProvider: MultiProvider) {
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
    return new CallCommitmentsService(multiProvider);
  }

  public async handleCommitment(req: Request, res: Response) {
    const data = this.parseCommitmentBody(req.body, res);
    if (!data) return;

    const commitment = commitmentFromIcaCalls(
      normalizeCalls(data.calls),
      data.salt,
    );
    let ica: string;
    try {
      ica = await this.validateCommitmentEvents(data, commitment);
    } catch (error: any) {
      console.error('Commitment dispatch validation failed', commitment, error);
      return res.status(400).json({ error: error.message });
    }

    await this.insertCommitmentToDB(commitment, { ...data, ica });
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
    data: z.infer<typeof postCallsSchema> & { ica: string },
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

  // Validate the commitment events by checking the transaction receipt
  // and parsing the events emitted by the InterchainAccountRouter.
  // This ensures that the commitment was dispatched correctly and
  // return the ICA address.
  // Throws if validation fails.
  private async validateCommitmentEvents(
    data: z.infer<typeof postCallsSchema>,
    commitment: string,
  ): Promise<string> {
    const provider = this.multiProvider.getProvider(data.originDomain);
    const receipt = await provider.getTransactionReceipt(
      data.commitmentDispatchTx,
    );
    if (!receipt)
      throw new Error(
        `Transaction not found: ${data.commitmentDispatchTx} on domain ${data.originDomain}`,
      );

    // Parse events with the router interface
    const iface = InterchainAccountRouter__factory.createInterface();

    // Check for CommitRevealDispatched
    const revealTopic = iface.getEventTopic('CommitRevealDispatched');
    const revealLog = receipt.logs.find((l) => l.topics[0] === revealTopic);
    if (!revealLog) throw new Error('CommitRevealDispatched event not found');
    const parsedReveal = iface.parseLog(revealLog);
    if (parsedReveal.args.commitment !== commitment) {
      throw new Error('Commitment mismatch on reveal');
    }

    // Find the RemoteCallDispatched event
    const callTopic = iface.getEventTopic('RemoteCallDispatched');
    const callLog = receipt.logs.find((l) => l.topics[0] === callTopic);
    if (!callLog) throw new Error('RemoteCallDispatched event not found');
    const parsedCall = iface.parseLog(callLog);
    const owner = addressToBytes32(parsedCall.args.owner);
    const destiantionRouterAddress = bytes32ToAddress(parsedCall.args.router);
    const ism = bytes32ToAddress(parsedCall.args.ism);
    const originRouter = addressToBytes32(callLog.address);
    const destinationDomain = parsedCall.args.destination as number;
    const salt = parsedCall.args.salt;

    // Derive the ICA by calling the on-chain view
    const destinationRouter = InterchainAccountRouter__factory.connect(
      destiantionRouterAddress,
      this.multiProvider.getProvider(destinationDomain),
    );
    return await destinationRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ](data.originDomain, owner, originRouter, ism, salt);
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router): void {
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
