import type { Log } from '@ethersproject/providers';
import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import {
  AccountConfig,
  InterchainAccount,
  MultiProvider,
  PostCallsIcaType,
  PostCallsLegacyType,
  PostCallsSchema,
  PostCallsType,
  isPostCallsIca,
  commitmentFromIcaCalls,
  commitmentFromRevealMessage,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  eqAddress,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../db.js';
import { createAbiHandler } from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithBaseUrl,
} from './BaseService.js';

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  SERVER_BASE_URL: z.string(),
});

// Zod schema for retrieving a commitment record
const CommitmentRecordSchema = z.object({
  commitment: z.string(),
  ica: z.string(),
  calls: z.array(z.any()),
  relayers: z.array(z.string()),
  salt: z.string(),
  originDomain: z.number(),
});

export class CallCommitmentsService extends BaseService {
  private multiProvider: MultiProvider;
  private baseUrl: string;

  constructor(
    config: ServiceConfigWithBaseUrl,
    private icaApp: InterchainAccount,
  ) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.baseUrl = config.baseUrl;
    this.registerRoutes(this.router, this.baseUrl);
  }

  static async create(serviceName: string): Promise<CallCommitmentsService> {
    const env = EnvSchema.parse(process.env);
    const registry = await this.getRegistry(env.REGISTRY_URI);

    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    const baseUrl = env.SERVER_BASE_URL + '/' + serviceName;

    // Build InterchainAccount app
    const coreAddresses = await registry.getAddresses();
    const icaApp = InterchainAccount.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    return new CallCommitmentsService(
      {
        serviceName,
        multiProvider,
        baseUrl,
      },
      icaApp,
    );
  }

  public async handleCommitment(req: Request, res: Response) {
    const logger = this.addLoggerServiceContext(req.log);

    logger.info({ body: req.body }, 'Received commitment creation request');

    const data = this.parseCommitmentBody(req.body, res, logger);
    if (!data) return;

    let commitment: string;
    try {
      commitment = commitmentFromIcaCalls(
        normalizeCalls(data.calls),
        data.salt,
      );
    } catch (error: unknown) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : error,
          calls: data.calls,
        },
        'Invalid call data',
      );
      return res.status(400).json({ error: 'Invalid call data' });
    }
    logger.setBindings({ commitment });

    logger.info(data, 'Processing commitment creation');

    let ica: string;
    try {
      if (isPostCallsIca(data)) {
        ica = await this.deriveIcaFromConfig(data, logger);
      } else {
        ica = await this.deriveIcaFromDispatchTx(data, logger);
      }
    } catch (error: any) {
      logger.warn(
        { error: error.message, stack: error.stack },
        'Failed to derive ICA address',
      );
      return res.status(400).json({
        error: `Failed to derive ICA address: ${error.message}`,
      });
    }

    // Attempt to insert the commitment. Using upsert for idempotency.
    try {
      await this.upsertCommitmentInDB(commitment, { ...data, ica }, logger);
    } catch (error: any) {
      // Any database error is unexpected.
      logger.error(
        {
          ...data,
          ica,
          error: error.message,
          stack: error.stack,
          error_reason: UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
        },
        'Database error during commitment processing',
      );
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
      );
      return res.status(500).json({ error: 'Internal server error' });
    }

    logger.info(data, 'Commitment processing completed successfully');
    return res.sendStatus(200);
  }

  public async handleFetchCommitment(
    message: string,
    relayer: string,
    logger: Logger,
  ) {
    const log = this.addLoggerServiceContext(logger);
    log.info({ message, relayer }, 'Handling fetch commitment request');

    try {
      const { body } = parseMessage(message);
      const commitment = commitmentFromRevealMessage(body);
      log.info(
        { commitment, message, relayer },
        'Extracted commitment from reveal message',
      );

      const record = await this.fetchCommitmentRecord(commitment, log);

      if (
        record.relayers.length > 0 &&
        !record.relayers.find((r: string) => eqAddress(r, relayer))
      ) {
        log.warn(
          {
            ...record,
            relayer,
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
          callsCount: record.calls.length,
        },
        'Serving calls for commitment',
      );

      return encoded;
    } catch (error: any) {
      log.error(
        {
          message,
          relayer,
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
   * Upsert a commitment record into the database.
   */
  private async upsertCommitmentInDB(
    commitment: string,
    data: PostCallsType & {
      ica: string;
    },
    logger: Logger,
  ) {
    const { calls, relayers, salt, ica, originDomain } = data;

    await prisma.commitment.upsert({
      where: { commitment },
      update: {}, // Do nothing if it already exists.
      create: {
        commitment,
        calls,
        relayers,
        salt,
        ica,
        originDomain,
      },
    });

    logger.info(
      {
        commitment,
        callsCount: calls.length,
        originDomain,
      },
      'Upserted commitment to database',
    );
  }

  /**
   * Fetch a commitment record from the database by revealMessageId.
   * Throws if not found.
   */
  private async fetchCommitmentRecord(commitment: string, logger: Logger) {
    logger.info({ commitment }, 'Fetching commitment from DB');

    const record = await prisma.commitment.findUnique({
      where: { commitment },
    });

    if (!record) {
      logger.warn({ commitment }, 'Commitment not found in DB');
      throw new Error('Commitment not found: ' + commitment);
    }

    const parsed = CommitmentRecordSchema.parse(record);
    logger.info(parsed, 'Successfully fetched commitment record');

    return parsed;
  }

  /**
   * New path: derive ICA from explicitly provided destination + owner.
   */
  private async deriveIcaFromConfig(
    data: PostCallsIcaType,
    logger: Logger,
  ): Promise<string> {
    const originChain = this.multiProvider.getChainName(data.originDomain);
    const destinationChain = this.multiProvider.getChainName(
      data.destinationDomain,
    );

    const accountConfig: AccountConfig = {
      origin: originChain,
      owner: data.owner,
      ismOverride: data.ismOverride,
    };

    logger.debug(
      { originChain, destinationChain, owner: data.owner },
      'Deriving ICA from config',
    );

    return this.icaApp.getAccount(destinationChain, accountConfig);
  }

  /**
   * Legacy path: derive ICA from the dispatch tx receipt events.
   */
  private async deriveIcaFromDispatchTx(
    data: PostCallsLegacyType,
    logger: Logger,
  ): Promise<string> {
    const provider = this.multiProvider.getProvider(data.originDomain);
    const receipt = await provider.getTransactionReceipt(
      data.commitmentDispatchTx,
    );

    if (!receipt) {
      throw new Error(
        `Transaction not found: ${data.commitmentDispatchTx} on domain ${data.originDomain}`,
      );
    }

    logger.info(
      {
        commitmentDispatchTx: data.commitmentDispatchTx,
        originDomain: data.originDomain,
      },
      'Deriving ICA from dispatch tx',
    );

    const iface = InterchainAccountRouter__factory.createInterface();
    const callTopic = iface.getEventTopic('RemoteCallDispatched');
    const callLog = receipt.logs.find((l: Log) => l.topics[0] === callTopic);
    if (!callLog) {
      throw new Error('RemoteCallDispatched event not found');
    }

    const parsedCall = iface.parseLog(callLog);
    const owner = addressToBytes32(parsedCall.args.owner);
    const destinationRouterAddress = bytes32ToAddress(parsedCall.args.router);
    const ismAddress = bytes32ToAddress(parsedCall.args.ism);
    const originRouter = addressToBytes32(callLog.address);
    const destinationDomain = parsedCall.args.destination as number;
    const salt = parsedCall.args.salt as string;

    const destinationRouter = InterchainAccountRouter__factory.connect(
      destinationRouterAddress,
      this.multiProvider.getProvider(destinationDomain),
    );
    return destinationRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ](data.originDomain, owner, originRouter, ismAddress, salt);
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router, baseUrl: string): void {
    const commitmentRateLimit = rateLimit({
      windowMs: 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        const ip = req.ip ?? 'unknown';
        PrometheusMetrics.logRateLimited(ip);
        res.status(429).json({ error: 'Too many requests' });
      },
    });

    router.post(
      '/calls',
      commitmentRateLimit,
      this.handleCommitment.bind(this),
    );
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
