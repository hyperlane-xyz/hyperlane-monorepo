import type { Log } from '@ethersproject/providers';
import { utils } from 'ethers';
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
} from '@hyperlane-xyz/sdk';
import {
  PostCallsIcaType,
  PostCallsLegacyType,
  PostCallsSchema,
  PostCallsType,
  commitmentFromIcaCalls,
  commitmentFromRevealMessage,
  encodeIcaCalls,
  isPostCallsIca,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import {
  addressToBytes32,
  bytes32ToAddress,
  assert,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { createAbiHandler } from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  RateLimitedMethod,
  RateLimitedRoute,
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

const CommitmentMetadataSchema = z.object({
  ica: z.string(),
  relayers: z.array(z.string()),
  originDomain: z.number(),
});

// Zod schema for retrieving a commitment record
const CommitmentRecordSchema = CommitmentMetadataSchema.extend({
  commitment: z.string(),
  calls: z.array(z.any()),
  salt: z.string(),
});

type CommitmentMetadata = z.infer<typeof CommitmentMetadataSchema>;

const commitmentMetadataSelect = {
  ica: true,
  originDomain: true,
  relayers: true,
} as const;

const RevealAccountSchema = z.object({
  pubkey: z.string(),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
});

const CalldataMetadataSchema = z.object({
  originDomain: z.number(),
  data: z.string(),
  salt: z.string(),
  relayers: z.array(z.string()),
  destinationAccount: z.string(),
  revealAccounts: z.array(RevealAccountSchema).nullish(),
});

const StoredCallSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
});

const commitmentReconciliationSelect = {
  ...commitmentMetadataSelect,
  calls: true,
  salt: true,
} as const;

const calldataMetadataSelect = {
  originDomain: true,
  data: true,
  salt: true,
  relayers: true,
  destinationAccount: true,
  revealAccounts: true,
} as const;

type CalldataPost = {
  commitment: string;
  originDomain: number;
  data: string;
  salt: string;
  relayers: string[];
  destinationAccount: string;
  revealAccounts?: Array<z.infer<typeof RevealAccountSchema>>;
};
type CalldataMetadata = z.infer<typeof CalldataMetadataSchema>;
type StoredCall = z.infer<typeof StoredCallSchema>;
type ReconciliationDb = Pick<
  Prisma.TransactionClient,
  'calldata' | 'commitment'
>;

class CommitmentConflictError extends Error {}

const EVM_RELAYER_REGEX = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function normalizedRelayerSet(relayers: string[]): string[] {
  return [
    ...new Set(
      relayers.map((relayer) => {
        if (EVM_RELAYER_REGEX.test(relayer)) {
          return addressToBytes32(
            '0x' + relayer.slice(2).toLowerCase(),
          ).toLowerCase();
        }
        return relayer;
      }),
    ),
  ].sort();
}

function includesRelayer(relayers: string[], relayer: string): boolean {
  const normalizedRelayer = normalizedRelayerSet([relayer])[0];
  return (
    normalizedRelayer !== undefined &&
    normalizedRelayerSet(relayers).includes(normalizedRelayer)
  );
}

function hasMatchingCommitmentMetadata(
  requested: CommitmentMetadata,
  stored: CommitmentMetadata,
): boolean {
  if (
    requested.ica.toLowerCase() !== stored.ica.toLowerCase() ||
    requested.originDomain !== stored.originDomain
  ) {
    return false;
  }

  const requestedRelayers = normalizedRelayerSet(requested.relayers);
  const storedRelayers = normalizedRelayerSet(stored.relayers);
  return (
    requestedRelayers.length === storedRelayers.length &&
    requestedRelayers.every(
      (relayer, index) => relayer === storedRelayers[index],
    )
  );
}

function isPrismaUniqueConstraintError(
  error: unknown,
): error is { code: 'P2002' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function hasMatchingRevealAccounts(
  requested: CalldataMetadata['revealAccounts'],
  stored: CalldataMetadata['revealAccounts'],
): boolean {
  const requestedAccounts = requested ?? [];
  const storedAccounts = stored ?? [];
  return (
    requestedAccounts.length === storedAccounts.length &&
    requestedAccounts.every((account, index) => {
      const storedAccount = storedAccounts[index];
      return (
        storedAccount !== undefined &&
        account.pubkey === storedAccount.pubkey &&
        account.isWritable === storedAccount.isWritable &&
        account.isSigner === storedAccount.isSigner
      );
    })
  );
}

function hasMatchingCalldataMetadata(
  requested: CalldataMetadata,
  stored: CalldataMetadata,
): boolean {
  return (
    requested.originDomain === stored.originDomain &&
    requested.data.toLowerCase() === stored.data.toLowerCase() &&
    requested.salt.toLowerCase() === stored.salt.toLowerCase() &&
    requested.destinationAccount.toLowerCase() ===
      stored.destinationAccount.toLowerCase() &&
    normalizedRelayerSet(requested.relayers).join(',') ===
      normalizedRelayerSet(stored.relayers).join(',') &&
    hasMatchingRevealAccounts(requested.revealAccounts, stored.revealAccounts)
  );
}

function hasMatchingLegacyCommitment(
  requested: CalldataPost,
  requestedCalls: StoredCall[],
  stored: CommitmentMetadata & { calls: unknown; salt: string },
): boolean {
  const parsedCalls = z.array(StoredCallSchema).safeParse(stored.calls);
  if (!parsedCalls.success) return false;

  let storedEncodedCalls: string;
  try {
    storedEncodedCalls = encodeIcaCalls(
      normalizeCalls(parsedCalls.data),
      stored.salt,
    );
  } catch {
    return false;
  }

  const requestedEncodedCalls = encodeIcaCalls(
    normalizeCalls(requestedCalls),
    requested.salt,
  );
  return (
    requestedEncodedCalls.toLowerCase() === storedEncodedCalls.toLowerCase() &&
    hasMatchingCommitmentMetadata(
      {
        ica: bytes32ToAddress(requested.destinationAccount),
        originDomain: requested.originDomain,
        relayers: requested.relayers,
      },
      stored,
    )
  );
}

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

    logger.info('Received commitment creation request');

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
          callsCount: data.calls.length,
        },
        'Invalid call data',
      );
      return res.status(400).json({ error: 'Invalid call data' });
    }
    logger.setBindings({ commitment });

    logger.info(
      {
        callsCount: data.calls.length,
        originDomain: data.originDomain,
        relayersCount: data.relayers.length,
      },
      'Processing commitment creation',
    );

    let ica: string;
    try {
      if (isPostCallsIca(data)) {
        ica = await this.deriveIcaFromConfig(data, logger);
      } else {
        ica = await this.deriveIcaFromDispatchTx(data, logger);
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to derive ICA address',
      );
      return res.status(400).json({
        error: `Failed to derive ICA address: ${errorMessage}`,
      });
    }

    let storedMetadata: CommitmentMetadata;
    try {
      storedMetadata = await this.upsertCommitmentInDB(
        commitment,
        { ...data, ica },
        logger,
      );
    } catch (error: unknown) {
      // Any database error is unexpected.
      logger.error(
        {
          commitment,
          callsCount: data.calls.length,
          originDomain: data.originDomain,
          relayersCount: data.relayers.length,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
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

    const requestedMetadata = {
      ica,
      originDomain: data.originDomain,
      relayers: data.relayers,
    };
    if (!hasMatchingCommitmentMetadata(requestedMetadata, storedMetadata)) {
      logger.warn(
        {
          commitment,
          requestedOriginDomain: data.originDomain,
          storedOriginDomain: storedMetadata.originDomain,
          requestedRelayersCount: data.relayers.length,
          storedRelayersCount: storedMetadata.relayers.length,
        },
        'Commitment already exists with different metadata',
      );
      return res
        .status(409)
        .json({ error: 'Commitment already exists with different metadata' });
    }

    logger.info(
      {
        commitment,
        originDomain: storedMetadata.originDomain,
        relayersCount: storedMetadata.relayers.length,
      },
      'Commitment processing completed successfully',
    );
    return res.status(200).json({
      commitment,
      ica: storedMetadata.ica,
      originDomain: storedMetadata.originDomain,
    });
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
        !includesRelayer(record.relayers, relayer)
      ) {
        log.warn(
          {
            commitment: record.commitment,
            relayer,
            authorizedRelayersCount: record.relayers.length,
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
      const errors = result.error.format();
      logger.warn({ errors }, 'Invalid request body received');
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
  ): Promise<CommitmentMetadata> {
    const { calls, relayers, salt, ica, originDomain } = data;

    let record;
    try {
      record = await prisma.commitment.upsert({
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
        select: commitmentMetadataSelect,
      });
    } catch (error: unknown) {
      if (!isPrismaUniqueConstraintError(error)) throw error;

      // Empty-update upserts may be client-handled by Prisma and race with a
      // concurrent create. Re-read the winning row instead of reporting 500.
      record = await prisma.commitment.findUnique({
        where: { commitment },
        select: commitmentMetadataSelect,
      });
      if (record === null) throw error;
    }

    logger.info(
      {
        commitment,
        callsCount: calls.length,
        originDomain,
      },
      'Upserted commitment to database',
    );

    return CommitmentMetadataSchema.parse(record);
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
    logger.info(
      {
        commitment: parsed.commitment,
        callsCount: parsed.calls.length,
        originDomain: parsed.originDomain,
        relayersCount: parsed.relayers.length,
      },
      'Successfully fetched commitment record',
    );

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
      userSalt: data.userSalt,
    };

    logger.debug(
      {
        originChain,
        destinationChain,
        owner: data.owner,
        userSalt: data.userSalt,
      },
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
   * GET /calls/:commitment — returns existence and stored routing metadata.
   * Used by the router status service to detect call_lost without a time threshold.
   */
  public async handleCheckCommitment(req: Request, res: Response) {
    const logger = this.addLoggerServiceContext(req.log);
    const { commitment } = req.params;
    assert(commitment, 'Route parameter :commitment must be present');
    res.set('Cache-Control', 'no-store');
    try {
      const record = await prisma.commitment.findUnique({
        where: { commitment },
        select: commitmentMetadataSelect,
      });
      if (record === null) return res.json({ exists: false });

      const metadata = CommitmentMetadataSchema.parse(record);
      return res.json({
        exists: true,
        ica: metadata.ica,
        originDomain: metadata.originDomain,
      });
    } catch (error: unknown) {
      logger.error(
        {
          commitment,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          error_reason: UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
        },
        'Database error during commitment existence check',
      );
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── /calldata endpoints ─────────────────────────────────────────────────────

  private static readonly RevealAccountSchema = z.object({
    pubkey: z
      .string()
      .regex(
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
        'pubkey must be a base58 Solana address',
      ),
    isWritable: z.boolean(),
    isSigner: z.boolean(),
  });

  private static readonly CalldataPostSchema = z.object({
    commitment: z
      .string()
      .regex(
        /^0x[0-9a-fA-F]{64}$/,
        'commitment must be a 32-byte 0x hex string',
      ),
    originDomain: z.number().int().positive(),
    data: z
      .string()
      .regex(
        /^0x(?:[0-9a-fA-F]{2})+$/,
        'data must be a non-empty byte-aligned 0x hex string',
      ),
    salt: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'salt must be a 32-byte 0x hex string'),
    relayers: z
      .array(
        z
          .string()
          .regex(
            /^0x[0-9a-fA-F]{40}$/,
            'relayer must be a 20-byte EVM address',
          ),
      )
      .default([]),
    destinationAccount: z
      .string()
      .regex(
        /^0x[0-9a-fA-F]{64}$/,
        'destinationAccount must be a 32-byte 0x hex string',
      ),
    revealAccounts: z
      .array(CallCommitmentsService.RevealAccountSchema)
      .optional(),
  });

  public async handleCalldataPost(req: Request, res: Response) {
    const logger = this.addLoggerServiceContext(req.log);
    const result = CallCommitmentsService.CalldataPostSchema.safeParse(
      req.body,
    );
    if (!result.success) {
      return res.status(400).json({ errors: result.error.format() });
    }
    const {
      commitment: requestedCommitment,
      originDomain,
      data,
      salt,
      relayers,
      revealAccounts,
    } = result.data;
    // Verify commitment = keccak256(salt || data) before persisting.
    // This prevents a client from poisoning a commitment slot with arbitrary data.
    const expectedCommitment = utils.keccak256(
      utils.concat([utils.arrayify(salt), utils.arrayify(data)]),
    );
    if (
      expectedCommitment.toLowerCase() !== requestedCommitment.toLowerCase()
    ) {
      return res
        .status(400)
        .json({ error: 'commitment does not match keccak256(salt || data)' });
    }
    const commitment = expectedCommitment;

    // Only EVM-destination routes carry ABI-encoded ICA calls. Decode before
    // writing so those routes can persist both records in one transaction.
    let decodedCalls: StoredCall[] | null = null;
    try {
      // CAST: ethers v5 ABI decoding returns Result rather than the tuple type.
      const [raw] = utils.defaultAbiCoder.decode(
        ['tuple(bytes32 to, uint256 value, bytes data)[]'],
        data,
      ) as [Array<{ to: string; value: { toString(): string }; data: string }>];
      decodedCalls = raw.map((call) => ({
        to: call.to,
        value: call.value.toString(),
        data: call.data,
      }));
    } catch {
      logger.debug(
        { commitment },
        'Skipping Commitment dual-write (data is not ABI-encoded ICA calls)',
      );
    }

    logger.info({ originDomain, commitment }, 'Storing calldata');
    try {
      await this.storeCalldata(
        { ...result.data, commitment },
        decodedCalls,
        logger,
      );
    } catch (error: unknown) {
      if (error instanceof CommitmentConflictError) {
        logger.warn(
          {
            commitment,
            originDomain,
            relayersCount: relayers.length,
            hasRevealAccounts: revealAccounts !== undefined,
          },
          'Commitment already exists with different metadata',
        );
        return res
          .status(409)
          .json({ error: 'Commitment already exists with different metadata' });
      }

      logger.error(
        {
          commitment,
          originDomain,
          error: error instanceof Error ? error.message : String(error),
          error_reason: UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
        },
        'Database error storing calldata',
      );
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.CALL_COMMITMENTS_DATABASE_ERROR,
      );
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(200).json({ commitment });
  }

  private async storeCalldata(
    data: CalldataPost,
    decodedCalls: StoredCall[] | null,
    logger: Logger,
  ): Promise<void> {
    const write = async (db: ReconciliationDb): Promise<void> => {
      const storedCalldata = CalldataMetadataSchema.parse(
        await db.calldata.upsert({
          where: { commitment: data.commitment },
          // Non-empty no-op update makes this a database-native upsert, avoiding
          // client-side create races while preserving first-write-wins semantics.
          update: { commitment: data.commitment },
          create: {
            commitment: data.commitment,
            originDomain: data.originDomain,
            data: data.data,
            salt: data.salt,
            relayers: data.relayers,
            destinationAccount: data.destinationAccount,
            ...(data.revealAccounts !== undefined && {
              revealAccounts: data.revealAccounts,
            }),
          },
          select: calldataMetadataSelect,
        }),
      );
      if (!hasMatchingCalldataMetadata(data, storedCalldata)) {
        throw new CommitmentConflictError();
      }

      if (decodedCalls === null) return;

      const storedCommitmentRecord = await db.commitment.upsert({
        where: { commitment: data.commitment },
        update: { commitment: data.commitment },
        create: {
          commitment: data.commitment,
          calls: decodedCalls,
          relayers: data.relayers,
          salt: data.salt,
          ica: bytes32ToAddress(data.destinationAccount),
          originDomain: data.originDomain,
        },
        select: commitmentReconciliationSelect,
      });
      const storedCommitment = {
        ...CommitmentMetadataSchema.parse(storedCommitmentRecord),
        calls: storedCommitmentRecord.calls,
        salt: storedCommitmentRecord.salt,
      };
      if (!hasMatchingLegacyCommitment(data, decodedCalls, storedCommitment)) {
        throw new CommitmentConflictError();
      }
    };

    if (decodedCalls === null) {
      await write(prisma);
      logger.info(
        { commitment: data.commitment, originDomain: data.originDomain },
        'Stored calldata',
      );
      return;
    }

    await prisma.$transaction(write);
    logger.info(
      { commitment: data.commitment, originDomain: data.originDomain },
      'Atomically stored calldata and legacy commitment',
    );
  }

  public async handleCalldataGet(req: Request, res: Response) {
    const logger = this.addLoggerServiceContext(req.log);
    const { commitment } = req.params;

    let record: {
      originDomain: number;
      data: string;
      salt: string;
      relayers: unknown;
      destinationAccount: string | null;
      revealAccounts: unknown;
    } | null;
    try {
      record = await prisma.calldata.findUnique({ where: { commitment } });
    } catch (error: unknown) {
      logger.error(
        {
          commitment,
          error: error instanceof Error ? error.message : String(error),
        },
        'Database error fetching calldata',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!record) return res.status(404).json({ error: 'Not found' });

    return res.status(200).json({
      originDomain: record.originDomain,
      data: record.data,
      salt: record.salt,
      ...(record.destinationAccount != null && {
        destinationAccount: record.destinationAccount,
      }),
      ...(record.revealAccounts != null && {
        revealAccounts: record.revealAccounts,
      }),
    });
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router, baseUrl: string): void {
    const toRateLimitedMethod = (method: string): RateLimitedMethod => {
      if (method === RateLimitedMethod.GET) return RateLimitedMethod.GET;
      if (method === RateLimitedMethod.POST) return RateLimitedMethod.POST;
      return RateLimitedMethod.OTHER;
    };
    const toRateLimitedRoute = (route: string): RateLimitedRoute => {
      return (
        Object.values(RateLimitedRoute).find(
          (knownRoute) => knownRoute === route,
        ) ?? RateLimitedRoute.Unknown
      );
    };
    const createRateLimit = () =>
      rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
          PrometheusMetrics.logRateLimited(
            toRateLimitedMethod(req.method),
            toRateLimitedRoute(req.route.path),
          );
          res.status(429).json({ error: 'Too many requests' });
        },
      });
    const writeRateLimit = createRateLimit();
    const readRateLimit = createRateLimit();

    router.post(
      RateLimitedRoute.Calls,
      writeRateLimit,
      this.handleCommitment.bind(this),
    );
    router.get(
      RateLimitedRoute.CallsByCommitment,
      readRateLimit,
      this.handleCheckCommitment.bind(this),
    );
    router.post(
      RateLimitedRoute.Calldata,
      writeRateLimit,
      this.handleCalldataPost.bind(this),
    );
    router.get(
      RateLimitedRoute.CalldataByCommitment,
      readRateLimit,
      this.handleCalldataGet.bind(this),
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
