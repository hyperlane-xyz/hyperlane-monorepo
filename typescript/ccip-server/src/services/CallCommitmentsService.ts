import type { TransactionReceipt } from '@ethersproject/providers';
import { Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { encodeIcaCalls, normalizeCalls } from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  ensure0x,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { CallCommitmentsAbi } from '../abis/CallCommitmentsAbi.js';
import { prisma } from '../db.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService } from './BaseService.js';

const EnvSchema = z.object({
  REGISTRY_URI: z
    .string()
    .transform((val) => val.split(',').map((s) => s.trim()))
    .optional(),
});

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
    const env = EnvSchema.parse(process.env);
    const registryUris = env.REGISTRY_URI ?? [DEFAULT_GITHUB_REGISTRY];
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
    let ica: string, revealMessageId: string;
    try {
      ({ ica, revealMessageId } = await this.validateCommitmentEvents(
        data,
        commitment,
      ));
    } catch (error: any) {
      console.error('Commitment dispatch validation failed', commitment, error);
      return res.status(400).json({ error: error.message });
    }

    await this.insertCommitmentToDB(commitment, {
      ...data,
      ica,
      revealMessageId,
    });
    res.sendStatus(200);
    return;
  }

  public async handleFetchCommitment(message: string) {
    try {
      const parsedMessage = parseMessage(message);
      // Parse the commitment from abi.encodePacked(MessageType.REVEAL, _ism, _commitment);
      const commitment = ensure0x(parsedMessage.body.slice(68, 132));
      const record = await this.fetchCommitmentRecord(
        commitment,
        messageId(message),
      );
      const encoded =
        record.ica +
        encodeIcaCalls(normalizeCalls(record.calls as any), record.salt).slice(
          2,
        );
      console.log('Serving calls for commitment', commitment);
      return encoded;
    } catch (error: any) {
      console.error('Error fetching commitment from message', message, error);
      return JSON.stringify({ error: error.message });
    }
  }

  /**
   * Extract the reveal message ID from the second DispatchId event in the receipt.
   */
  private extractRevealMessageId(receipt: TransactionReceipt): string {
    const dispatchIdTopic =
      Mailbox__factory.createInterface().getEventTopic('DispatchId');
    const dispatchLogs = receipt.logs.filter(
      (l) => l.topics[0] === dispatchIdTopic,
    );
    if (dispatchLogs.length < 2) {
      throw new Error('Reveal DispatchId event not found');
    }
    return dispatchLogs[1].topics[1];
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
    data: z.infer<typeof postCallsSchema> & {
      ica: string;
      revealMessageId: string;
    },
  ) {
    const {
      calls,
      relayers,
      salt,
      ica,
      revealMessageId,
      commitmentDispatchTx,
      originDomain,
    } = data;
    await prisma.commitment.create({
      data: {
        commitment,
        revealMessageId,
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
  private async fetchCommitmentRecord(
    commitment: string,
    revealMessageId: string,
  ) {
    console.log('Fetching commitment from DB', commitment, revealMessageId);
    const record = await prisma.commitment.findUnique({
      where: { commitment_revealMessageId: { commitment, revealMessageId } },
    });
    if (!record) {
      console.log('Commitment not found in DB', commitment, revealMessageId);
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
  ): Promise<{ ica: string; revealMessageId: string }> {
    const provider = this.multiProvider.getProvider(data.originDomain);
    const receipt = await provider.getTransactionReceipt(
      data.commitmentDispatchTx,
    );
    if (!receipt)
      throw new Error(
        `Transaction not found: ${data.commitmentDispatchTx} on domain ${data.originDomain}`,
      );

    // 2) Verify reveal event
    this.ensureCommitmentDispatched(receipt, commitment);

    // 3) Extract reveal message ID
    const revealMessageId = this.extractRevealMessageId(receipt);

    // 4) Derive ICA from RemoteCallDispatched
    const ica = await this.deriveIcaFromRemoteCallDispatched(
      receipt,
      data.originDomain,
    );
    return { ica, revealMessageId };
  }

  /**
   * Ensure a CommitRevealDispatched event matching the commitment exists.
   */
  private ensureCommitmentDispatched(receipt: any, commitment: string): void {
    const iface = InterchainAccountRouter__factory.createInterface();
    const revealTopic = iface.getEventTopic('CommitRevealDispatched');
    const revealLogs = receipt.logs.filter(
      (l: any) => l.topics[0] === revealTopic,
    );
    if (revealLogs.length === 0) {
      throw new Error('CommitRevealDispatched event not found');
    }

    const matched = revealLogs
      .map((l: any) => iface.parseLog(l))
      .some((parsed: any) => parsed.args.commitment === commitment);

    if (!matched) {
      const foundCommitments = revealLogs.map(
        (l: any) => iface.parseLog(l).args.commitment,
      );
      throw new Error(
        `No matching CommitRevealDispatched for this commitment: ${commitment}. Found commitments: ${foundCommitments.join(', ')}`,
      );
    }
  }

  /**
   * Parse the RemoteCallDispatched event from the receipt and derive the ICA address.
   */
  private async deriveIcaFromRemoteCallDispatched(
    receipt: TransactionReceipt,
    originDomain: number,
  ): Promise<string> {
    const iface = InterchainAccountRouter__factory.createInterface();
    const callTopic = iface.getEventTopic('RemoteCallDispatched');
    const callLog = receipt.logs.find((l) => l.topics[0] === callTopic);
    if (!callLog) throw new Error('RemoteCallDispatched event not found');
    const parsedCall = iface.parseLog(callLog);
    const owner = addressToBytes32(parsedCall.args.owner);
    const destinationRouterAddress = bytes32ToAddress(parsedCall.args.router);
    const ismAddress = bytes32ToAddress(parsedCall.args.ism);
    const originRouter = addressToBytes32(callLog.address);
    const destinationDomain = parsedCall.args.destination as number;
    const salt = parsedCall.args.salt as string;

    // Derive the ICA by calling the on-chain view
    const destinationRouter = InterchainAccountRouter__factory.connect(
      destinationRouterAddress,
      this.multiProvider.getProvider(destinationDomain),
    );
    return destinationRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ](originDomain, owner, originRouter, ismAddress, salt);
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router): void {
    router.post('/calls', this.handleCommitment.bind(this));
    router.post(
      '/getCallsFromRevealMessage',
      createAbiHandler(
        CallCommitmentsAbi,
        'getCallsFromRevealMessage',
        this.handleFetchCommitment.bind(this),
        true, // Skip ABI encoding of the result
      ),
    );
  }
}
