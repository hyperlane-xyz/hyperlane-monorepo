import type { TransactionReceipt } from '@ethersproject/providers';
import { Request, Response, Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  MultiProvider,
  PostCallsSchema,
  PostCallsType,
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  eqAddress,
  messageId,
} from '@hyperlane-xyz/utils';

import { prisma } from '../db.js';
import { createAbiHandler } from '../utils/abiHandler.js';
import { PrometheusMetrics } from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfig,
  ServiceConfigWithBaseUrl,
} from './BaseService.js';

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  SERVER_BASE_URL: z.string(),
});

// Zod schema for retrieving a commitment record, reusing PostCallsSchema for common fields
const CommitmentRecordSchema = PostCallsSchema.extend({
  commitment: z.string(),
  revealMessageId: z.string(),
  ica: z.string(),
});

// TODO: Authenticate relayer
export class CallCommitmentsService extends BaseService {
  private multiProvider: MultiProvider;
  private baseUrl: string;

  constructor(config: ServiceConfigWithBaseUrl) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.baseUrl = config.baseUrl;
    this.registerRoutes(this.router, this.baseUrl);
  }

  static async create(config: ServiceConfig): Promise<CallCommitmentsService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    const namespace = config.namespace || 'callCommitments';
    const baseUrl = env.SERVER_BASE_URL + '/' + namespace;

    return new CallCommitmentsService({
      ...config,
      multiProvider,
      baseUrl,
    });
  }

  public async handleCommitment(req: Request, res: Response) {
    const logger = this.getServiceLogger(req.log);

    const data = this.parseCommitmentBody(req.body, res, logger);
    if (!data) return;

    const commitment = commitmentFromIcaCalls(
      normalizeCalls(data.calls),
      data.salt,
    );

    logger.info(
      {
        commitment,
        callsCount: data.calls.length,
        originDomain: data.originDomain,
      },
      'Processing commitment creation',
    );

    let ica: string, revealMessageId: string;
    try {
      ({ ica, revealMessageId } = await this.validateCommitmentEvents(
        data,
        commitment,
        logger,
      ));
    } catch (error: any) {
      // TODO: distinguish between infrastructure vs client errors
      logger.warn(
        {
          commitment,
          error: error.message,
          stack: error.stack,
        },
        'Commitment dispatch validation failed',
      );
      return res.status(400).json({ error: error.message });
    }

    // Check if commitment already exists before attempting insert
    try {
      const existingRecord = await prisma.commitment.findUnique({
        where: { revealMessageId },
        select: { commitment: true }, // Only need to check existence
      });

      if (existingRecord) {
        logger.info(
          {
            commitment,
            revealMessageId,
          },
          'Commitment already exists - returning success',
        );
        return res.sendStatus(200); // Idempotent operation
      }

      // No existing record, proceed with insert
      await this.insertCommitmentToDB(
        commitment,
        { ...data, ica, revealMessageId },
        logger,
      );
    } catch (error: any) {
      logger.error(
        {
          commitment,
          error: error.message,
          stack: error.stack,
        },
        'Database error during commitment processing',
      );

      PrometheusMetrics.logUnhandledError();
      return res.status(500).json({ error: 'Internal server error' });
    }

    logger.info({ commitment }, 'Commitment processing completed successfully');
    return res.sendStatus(200);
  }

  public async handleFetchCommitment(
    message: string,
    relayer: string,
    logger: Logger,
  ) {
    const log = this.getServiceLogger(logger);

    try {
      const revealMsgId = messageId(message);
      log.debug({ revealMsgId }, 'Generated reveal message ID');

      const record = await this.fetchCommitmentRecord(revealMsgId, log);

      if (
        record.relayers.length > 0 &&
        !record.relayers.find((r) => eqAddress(r, relayer))
      ) {
        log.warn(
          {
            revealMsgId,
            message,
            relayer,
            commitment: record.commitment,
          },
          'Relayer not authorized for this commitment',
        );
        throw new Error(
          `Relayer ${relayer} not authorized for this commitment`,
        );
      }

      const encoded =
        record.ica +
        encodeIcaCalls(normalizeCalls(record.calls), record.salt).slice(2);

      log.info(
        {
          commitment: record.commitment,
          revealMsgId,
          callsCount: record.calls.length,
        },
        'Serving calls for commitment',
      );

      return encoded;
    } catch (error: any) {
      log.error(
        {
          message,
          error: error.message,
          stack: error.stack,
        },
        'Error fetching commitment from message',
      );
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
    logger: Logger,
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
      logger.warn(
        { receipt, commitment },
        'CommitRevealDispatched event not found in logs',
      );
      throw new Error('CommitRevealDispatched event not found in logs');
    }

    // Find the next two DispatchId logs after the CommitRevealDispatched
    const dispatchLogsAfterReveal = receipt.logs
      .slice(revealIndex + 1)
      .filter((log) => log.topics[0] === dispatchIdTopic);

    if (dispatchLogsAfterReveal.length < 2) {
      logger.warn(
        { receipt, commitment },
        'Not enough DispatchId events after CommitRevealDispatched',
      );
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
  private parseCommitmentBody(body: any, res: Response, logger: Logger) {
    const result = PostCallsSchema.safeParse(body);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      logger.warn({ errors, body }, 'Invalid request body received');
      res.status(400).json({ errors });
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
    logger: Logger,
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

    logger.info(
      {
        commitment,
        revealMessageId,
        ica,
        callsCount: calls.length,
        originDomain,
      },
      'Stored commitment to database',
    );
  }

  /**
   * Fetch a commitment record from the database by revealMessageId.
   * Throws if not found.
   */
  private async fetchCommitmentRecord(revealMessageId: string, logger: Logger) {
    logger.debug(
      { revealMessageId },
      'Fetching commitment from DB with revealMessageId',
    );

    const record = await prisma.commitment.findUnique({
      where: { revealMessageId },
    });

    if (!record) {
      logger.warn(
        { revealMessageId },
        'Commitment not found in DB with revealMessageId',
      );
      throw new Error(
        'Commitment not found for revealMessageId: ' + revealMessageId,
      );
    }

    const parsed = CommitmentRecordSchema.parse(record);
    logger.debug(
      { commitment: parsed.commitment },
      'Successfully fetched commitment record',
    );

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
    logger: Logger,
  ): Promise<{ ica: string; revealMessageId: string }> {
    const provider = this.multiProvider.getProvider(data.originDomain);
    const receipt = await provider.getTransactionReceipt(
      data.commitmentDispatchTx,
    );

    if (!receipt) {
      logger.error(
        {
          transactionHash: data.commitmentDispatchTx,
          originDomain: data.originDomain,
        },
        'Transaction not found',
      );
      throw new Error(
        `Transaction not found: ${data.commitmentDispatchTx} on domain ${data.originDomain}`,
      );
    }

    logger.info(
      {
        transactionHash: receipt.transactionHash,
        commitment,
        originDomain: data.originDomain,
      },
      'Validating commitment events',
    );

    // 2) Extract reveal message ID
    const revealMessageId =
      this.extractRevealMessageIdAndValidateDispatchedCommitment(
        receipt,
        commitment,
        logger,
      );

    // 3) Derive ICA from RemoteCallDispatched
    const ica = await this.deriveIcaFromRemoteCallDispatched(
      receipt,
      data.originDomain,
      logger,
    );

    logger.info(
      {
        commitment,
        ica,
        revealMessageId,
      },
      'Commitment validation successful',
    );

    return { ica, revealMessageId };
  }

  /**
   * Parse the RemoteCallDispatched event from the receipt and derive the ICA address.
   */
  private async deriveIcaFromRemoteCallDispatched(
    receipt: TransactionReceipt,
    originDomain: number,
    logger: Logger,
  ): Promise<string> {
    const iface = InterchainAccountRouter__factory.createInterface();
    const callTopic = iface.getEventTopic('RemoteCallDispatched');
    const callLog = receipt.logs.find((l) => l.topics[0] === callTopic);
    if (!callLog) {
      logger.warn({ receipt }, 'RemoteCallDispatched event not found');
      throw new Error('RemoteCallDispatched event not found');
    }
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
  private registerRoutes(router: Router, baseUrl: string): void {
    router.post('/calls', this.handleCommitment.bind(this));
    router.post(
      '/getCallsFromRevealMessage',
      createAbiHandler(
        CommitmentReadIsmService__factory,
        'getCallsFromRevealMessage',
        this.handleFetchCommitment.bind(this),
        {
          skipResultEncoding: true,
          verifyRelayerSignatureUrl: `${baseUrl}/getCallsFromRevealMessage`,
        },
      ),
    );
  }
}
