import type { TransactionReceipt } from '@ethersproject/providers';
import { Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  PostCallsSchema,
  PostCallsType,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  ensure0x,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../db.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService, REGISTRY_URI_SCHEMA } from './BaseService.js';

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

// Zod schema for retrieving a commitment record, reusing PostCallsSchema for common fields
const CommitmentRecordSchema = PostCallsSchema.extend({
  commitment: z.string(),
  revealMessageId: z.string(),
  ica: z.string(),
});

// TODO: Authenticate relayer
export class CallCommitmentsService extends BaseService {
  constructor(private multiProvider: MultiProvider) {
    super();
    this.registerRoutes(this.router);
  }

  static async initialize() {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await this.getMultiProvider(env.REGISTRY_URI);
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
      const revealMsgId = messageId(message);
      const record = await this.fetchCommitmentRecord(revealMsgId);
      const encoded =
        record.ica +
        encodeIcaCalls(normalizeCalls(record.calls), record.salt).slice(2);
      console.log('Serving calls for commitment', record.commitment);
      return encoded;
    } catch (error: any) {
      console.error('Error fetching commitment from message', message, error);
      // TODO we might not want to show the error
      return JSON.stringify({ error: error.message });
    }
  }

  /**
   * Extract the reveal message ID from the transaction receipt.
   * Finds the second DispatchId event after the CommitRevealDispatched event.
   */
  private extractRevealMessageIdAndValidateDispatchedCommitment(
    receipt: TransactionReceipt,
    commitment: string,
  ): string {
    const iface = InterchainAccountRouter__factory.createInterface();
    const dispatchIdTopic =
      Mailbox__factory.createInterface().getEventTopic('DispatchId');
    const revealDispatchedTopic = iface.getEventTopic('CommitRevealDispatched');

    // Find the index of the CommitRevealDispatched log with the given commitment
    const revealIndex = receipt.logs.findIndex(
      (log) =>
        log.topics[0] === revealDispatchedTopic &&
        iface.parseLog(log).args.commitment === commitment,
    );
    if (revealIndex === -1) {
      throw new Error('CommitRevealDispatched event not found in logs');
    }

    // Find the next two DispatchId logs after the CommitRevealDispatched
    const dispatchLogsAfterReveal = receipt.logs
      .slice(revealIndex + 1)
      .filter((log) => log.topics[0] === dispatchIdTopic);

    if (dispatchLogsAfterReveal.length < 2) {
      throw new Error(
        'Not enough DispatchId events after CommitRevealDispatched',
      );
    }

    return dispatchLogsAfterReveal[1].topics[1];
  }

  /**
   * Validate and parse the request body against the Zod schema.
   * Returns parsed data or sends a 400 response and returns null.
   */
  private parseCommitmentBody(body: any, res: Response) {
    const result = PostCallsSchema.safeParse(body);
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
    data: PostCallsType & {
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
    console.log('Stored commitment', { commitment, ...data });
  }

  /**
   * Fetch a commitment record from the database by revealMessageId.
   * Throws if not found.
   */
  private async fetchCommitmentRecord(revealMessageId: string) {
    console.log(
      'Fetching commitment from DB with revealMessageId',
      revealMessageId,
    );
    const record = await prisma.commitment.findUnique({
      where: { revealMessageId },
    });
    if (!record) {
      console.log(
        'Commitment not found in DB with revealMessageId',
        revealMessageId,
      );
      throw new Error(
        'Commitment not found for revealMessageId: ' + revealMessageId,
      );
    }
    const parsed = CommitmentRecordSchema.parse(record);
    return parsed;
  }

  // Validate the commitment events by checking the transaction receipt
  // and parsing the events emitted by the InterchainAccountRouter.
  // This ensures that the commitment was dispatched correctly and
  // return the ICA address.
  // Throws if validation fails.
  private async validateCommitmentEvents(
    data: PostCallsType,
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

    // 2) Extract reveal message ID
    const revealMessageId =
      this.extractRevealMessageIdAndValidateDispatchedCommitment(
        receipt,
        commitment,
      );

    // 3) Derive ICA from RemoteCallDispatched
    const ica = await this.deriveIcaFromRemoteCallDispatched(
      receipt,
      data.originDomain,
    );
    return { ica, revealMessageId };
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
        CommitmentReadIsmService__factory,
        'getCallsFromRevealMessage',
        this.handleFetchCommitment.bind(this),
        true, // Skip ABI encoding of the result
      ),
    );
  }
}
