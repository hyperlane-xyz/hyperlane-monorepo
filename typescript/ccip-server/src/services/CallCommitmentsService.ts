import type { Log } from '@ethersproject/providers';
import { utils } from 'ethers';
import type { FastifyReply } from 'fastify';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { InterchainAccount } from '@hyperlane-xyz/sdk/middleware/account/InterchainAccount';
import type { AccountConfig } from '@hyperlane-xyz/sdk/middleware/account/types';
import type { MultiProvider } from '@hyperlane-xyz/sdk/providers/MultiProvider';
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
  assert,
  bytes32ToAddress,
  eqAddress,
  isEmptyAddress,
  isNullish,
  isZeroishAddress,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CcipApp, CcipRequest, CommitmentParams } from '../http.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  RateLimitedRoute,
  UnhandledErrorReason,
} from '../utils/prometheus.js';
import { createRateLimitHook } from '../utils/rateLimit.js';
import { CommitmentAccessDeniedError } from '../utils/errors.js';
import { CcsAuth, CcsSignerSchema } from '../utils/ccsAuth.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithBaseUrl,
} from './BaseService.js';

export const CalldataLookupEnabledSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  SERVER_BASE_URL: z.string(),
  CCS_AUTHORIZED_SIGNERS: z
    .string()
    .transform((value) =>
      z.array(CcsSignerSchema).min(1).parse(JSON.parse(value)),
    ),
  CCS_CALLDATA_LOOKUP_ENABLED: CalldataLookupEnabledSchema,
});

const CommitmentMetadataSchema = z.object({
  ica: z.string(),
  relayers: z.array(z.string()),
  originDomain: z.number(),
});

const CommitmentRoutingSchema = CommitmentMetadataSchema.pick({
  ica: true,
  originDomain: true,
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

/** Empty record lists permit any globally authenticated signer. */
function isAuthorizedRelayer(relayers: string[], relayer: string): boolean {
  if (relayers.length === 0) return true;
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

/** Registry keys of the ICA router deployments that run in parallel. */
const ICA_ROUTER_VERSIONS = [
  'interchainAccountRouter',
  'interchainAccountRouterV3',
] as const;
type IcaRouterVersion = (typeof ICA_ROUTER_VERSIONS)[number];
export type IcaRouters = Partial<Record<IcaRouterVersion, string>>;

/** Per-domain values selected from the registry addresses of known chains. */
function registryValuesByDomain<T>(
  addressesByChain: Record<string, Record<string, string>>,
  multiProvider: MultiProvider,
  select: (addresses: Record<string, string>) => T | undefined,
): Map<number, T> {
  const values = new Map<number, T>();
  for (const [chain, addresses] of Object.entries(addressesByChain)) {
    const domain = multiProvider.tryGetDomainId(chain);
    if (isNullish(domain)) continue;
    const value = select(addresses);
    if (value === undefined) continue;
    values.set(domain, value);
  }
  return values;
}

/**
 * The registry's ICA routers by domain and version, lowercased. Empty and
 * zero-ish router addresses are ignored, and chains without an ICA router are
 * omitted.
 */
export function icaRoutersByDomain(
  addressesByChain: Record<string, Record<string, string>>,
  multiProvider: MultiProvider,
): Map<number, IcaRouters> {
  return registryValuesByDomain(
    addressesByChain,
    multiProvider,
    (addresses) => {
      const domainRouters: IcaRouters = Object.fromEntries(
        ICA_ROUTER_VERSIONS.flatMap((version) => {
          const router = addresses[version];
          if (isEmptyAddress(router)) return [];
          return [[version, router.toLowerCase()]];
        }),
      );
      return Object.keys(domainRouters).length === 0
        ? undefined
        : domainRouters;
    },
  );
}

/**
 * The registry's mailboxes by domain, lowercased. Empty and zero-ish mailbox
 * addresses are ignored.
 */
export function mailboxesByDomain(
  addressesByChain: Record<string, Record<string, string>>,
  multiProvider: MultiProvider,
): Map<number, string> {
  return registryValuesByDomain(addressesByChain, multiProvider, (addresses) =>
    isEmptyAddress(addresses.mailbox)
      ? undefined
      : addresses.mailbox.toLowerCase(),
  );
}

export class CallCommitmentsService extends BaseService {
  private multiProvider: MultiProvider;
  private readonly auth: CcsAuth;

  constructor(
    config: ServiceConfigWithBaseUrl,
    private icaApp: InterchainAccount,
    authorizedSigners: string[],
    private readonly trustedIcaRouters: ReadonlyMap<number, IcaRouters>,
    private readonly calldataLookupEnabled: boolean,
    private readonly originMailboxes: ReadonlyMap<number, string>,
  ) {
    super(config);
    assert(
      trustedIcaRouters.size > 0,
      'No ICA routers configured: callCommitments requires interchainAccountRouter or interchainAccountRouterV3 registry addresses',
    );
    for (const domain of trustedIcaRouters.keys()) {
      assert(
        originMailboxes.has(domain),
        `Missing mailbox address for domain ${domain}`,
      );
    }
    this.multiProvider = config.multiProvider;
    this.auth = new CcsAuth(config.baseUrl, authorizedSigners);
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
      env.CCS_AUTHORIZED_SIGNERS,
      icaRoutersByDomain(coreAddresses, multiProvider),
      env.CCS_CALLDATA_LOOKUP_ENABLED,
      mailboxesByDomain(coreAddresses, multiProvider),
    );
  }

  public async handleCommitment(req: CcipRequest, res: FastifyReply) {
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
      return res.code(400).send({ error: 'Invalid call data' });
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
      return res.code(400).send({
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
      return res.code(500).send({ error: 'Internal server error' });
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
        .code(409)
        .send({ error: 'Commitment already exists with different metadata' });
    }

    logger.info(
      {
        commitment,
        originDomain: storedMetadata.originDomain,
        relayersCount: storedMetadata.relayers.length,
      },
      'Commitment processing completed successfully',
    );
    return res.code(200).send({
      commitment,
      ica: storedMetadata.ica,
      originDomain: storedMetadata.originDomain,
    });
  }

  public async handleFetchCommitment(
    message: string,
    relayer: string,
    logger: Logger,
    originTxHash?: string,
  ) {
    const log = this.addLoggerServiceContext(logger);
    log.info({ message, relayer }, 'Handling fetch commitment request');

    try {
      const { body, origin } = parseMessage(message);
      const commitment = commitmentFromRevealMessage(body);
      log.info(
        { commitment, message, relayer },
        'Extracted commitment from reveal message',
      );

      const record = await this.fetchCommitmentRecord(commitment, log);

      if (!isAuthorizedRelayer(record.relayers, relayer)) {
        log.warn(
          {
            commitment: record.commitment,
            relayer,
            authorizedRelayersCount: record.relayers.length,
          },
          'Relayer not authorized for this commitment',
        );
        throw new CommitmentAccessDeniedError();
      }

      if (origin !== record.originDomain) {
        throw new CommitmentAccessDeniedError(
          'Reveal origin does not match stored commitment',
        );
      }
      // Calls are resolved from the commitment dispatched alongside this
      // reveal, which must target the account the calls were registered for.
      // Without the origin transaction hash the request returns HTTP 500 and
      // the relayer retries.
      assert(
        originTxHash,
        'Missing origin transaction hash for reveal message',
      );
      const { ica, routerVersionIcas, failedCandidates } =
        await this.deriveIcaFromRevealMessage(message, originTxHash, log);
      // Records registered without router overrides store the V2-derived
      // ICA; a candidate equal to the stored ICA admits the reveal, and the
      // dispatched ICA is served.
      if (
        ![ica, ...routerVersionIcas].some((candidate) =>
          eqAddress(candidate, record.ica),
        )
      ) {
        // A candidate that could not be derived might have matched: that is
        // not a denial, so fail with HTTP 500 and let the relayer retry.
        assert(
          failedCandidates === 0,
          'Could not derive every ICA candidate for the reveal',
        );
        log.warn(
          {
            commitment,
            originTxHash,
            storedIca: record.ica,
            revealIca: ica,
          },
          'Paired commitment does not derive the stored ICA',
        );
        throw new CommitmentAccessDeniedError(
          'Reveal does not belong to this commitment',
        );
      }

      if (!eqAddress(ica, record.ica)) {
        log.info(
          { commitment, originTxHash, storedIca: record.ica, revealIca: ica },
          'Serving the dispatched ICA; the stored ICA was derived with another router version or ISM',
        );
      }
      const encoded =
        ica +
        encodeIcaCalls(normalizeCalls(record.calls), record.salt).slice(2);

      log.info(
        {
          commitment: record.commitment,
          callsCount: record.calls.length,
        },
        'Serving calls for commitment',
      );

      return encoded;
    } catch (error: unknown) {
      if (error instanceof CommitmentAccessDeniedError) {
        log.warn(
          { message, relayer, originTxHash, reason: error.message },
          'Commitment access denied',
        );
        throw error;
      }
      log.error(
        {
          message,
          relayer,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Error fetching commitment from message',
      );
      throw error;
    }
  }

  private isTrustedIcaRouter(domain: number, router: string): boolean {
    return Object.values(this.trustedIcaRouters.get(domain) ?? {}).includes(
      bytes32ToAddress(router).toLowerCase(),
    );
  }

  /**
   * Finds the commitment dispatched alongside a reveal and derives the ICA it
   * targets: `ica` from the routers it was dispatched through, and
   * `routerVersionIcas`, one per registry router version and ISM variant that
   * could be derived, from the same owner and user salt (see
   * `handleFetchCommitment`). `failedCandidates` counts those that could not.
   *
   * The reveal must be in the given transaction's mailbox logs, and both of
   * its routers must be ICA routers from the registry.
   */
  private async deriveIcaFromRevealMessage(
    message: string,
    originTxHash: string,
    log: Logger,
  ): Promise<{
    ica: string;
    routerVersionIcas: string[];
    failedCandidates: number;
  }> {
    const reveal = parseMessage(message);
    assert(
      utils.hexDataLength(reveal.body) === 65 &&
        utils.hexDataSlice(reveal.body, 0, 1) === '0x02',
      'Invalid ICA reveal message',
    );
    if (
      !this.isTrustedIcaRouter(reveal.origin, reveal.sender) ||
      !this.isTrustedIcaRouter(reveal.destination, reveal.recipient)
    ) {
      throw new CommitmentAccessDeniedError(
        'Reveal was not dispatched between known ICA routers',
      );
    }
    const mailbox = this.originMailboxes.get(reveal.origin);
    assert(mailbox, `Missing mailbox address for domain ${reveal.origin}`);
    const commitment = commitmentFromRevealMessage(reveal.body);
    const originChain = this.multiProvider.getChainName(reveal.origin);
    const provider = this.multiProvider.getProvider(originChain);
    const receipt = await provider.getTransactionReceipt(originTxHash);
    assert(receipt, `Transaction not found: ${originTxHash}`);

    const iface = Mailbox__factory.createInterface();
    const dispatchTopic = iface.getEventTopic('Dispatch');
    const dispatches = receipt.logs
      .filter(
        (receiptLog) =>
          receiptLog.address.toLowerCase() === mailbox.toLowerCase() &&
          receiptLog.topics[0] === dispatchTopic,
      )
      .map((receiptLog) => {
        const dispatchedMessage = z
          .string()
          .parse(iface.parseLog(receiptLog).args.message);
        return { log: receiptLog, message: dispatchedMessage };
      });
    const revealDispatch = dispatches.find(
      (dispatch) => dispatch.message.toLowerCase() === message.toLowerCase(),
    );
    if (!revealDispatch) {
      throw new CommitmentAccessDeniedError(
        'Reveal message not found in origin transaction',
      );
    }

    // A dispatch hook can nest another commit/reveal using the same hash.
    // Consume earlier reveals so the outer reveal retains its own commitment.
    const pendingCommitments: ReturnType<typeof parseMessage>[] = [];
    let committed: ReturnType<typeof parseMessage> | undefined;
    for (const dispatch of dispatches.sort(
      (left, right) => left.log.logIndex - right.log.logIndex,
    )) {
      if (dispatch.log.logIndex > revealDispatch.log.logIndex) break;
      const candidate = parseMessage(dispatch.message);
      if (
        candidate.origin !== reveal.origin ||
        candidate.destination !== reveal.destination ||
        candidate.sender.toLowerCase() !== reveal.sender.toLowerCase() ||
        candidate.recipient.toLowerCase() !== reveal.recipient.toLowerCase()
      ) {
        continue;
      }
      if (
        utils.hexDataLength(candidate.body) === 129 &&
        utils.hexDataSlice(candidate.body, 0, 1) === '0x01' &&
        utils.hexDataSlice(candidate.body, 97, 129).toLowerCase() ===
          commitment.toLowerCase()
      ) {
        pendingCommitments.push(candidate);
      } else if (
        utils.hexDataLength(candidate.body) === 65 &&
        utils.hexDataSlice(candidate.body, 0, 1) === '0x02' &&
        utils.hexDataSlice(candidate.body, 33, 65).toLowerCase() ===
          commitment.toLowerCase()
      ) {
        const paired = pendingCommitments.pop();
        if (dispatch.log.logIndex === revealDispatch.log.logIndex) {
          committed = paired;
          break;
        }
      }
    }
    if (!committed) {
      throw new CommitmentAccessDeniedError(
        'Matching commitment dispatch not found',
      );
    }
    const owner = utils.hexDataSlice(committed.body, 1, 33);
    const ism = utils.hexDataSlice(committed.body, 33, 65);
    const userSalt = utils.hexDataSlice(committed.body, 65, 97);

    const destinationRouter = InterchainAccountRouter__factory.connect(
      bytes32ToAddress(reveal.recipient),
      this.multiProvider.getProvider(reveal.destination),
    );
    // Registrations derive their ICA with whichever router pair they were
    // given, or the default (V2) pair when none: try each pair the registry
    // has for both chains, with and without the commit's ISM since
    // registrations may not have passed one.
    const destinationChain = this.multiProvider.getChainName(
      reveal.destination,
    );
    const originRouters = this.trustedIcaRouters.get(reveal.origin) ?? {};
    const destinationRouters =
      this.trustedIcaRouters.get(reveal.destination) ?? {};
    const ismOverrides = isZeroishAddress(bytes32ToAddress(ism))
      ? [undefined]
      : [undefined, ism];
    const [ica, versionResults] = await Promise.all([
      destinationRouter[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ](reveal.origin, owner, reveal.sender, bytes32ToAddress(ism), userSalt),
      // A version that cannot be derived (e.g. a pre-salt router) is counted,
      // not fatal: it cannot make a reveal match, so any other match still
      // serves, and with none the request fails so the relayer retries.
      Promise.allSettled(
        ICA_ROUTER_VERSIONS.flatMap((version) => {
          const localRouter = originRouters[version];
          const routerOverride = destinationRouters[version];
          if (localRouter === undefined || routerOverride === undefined) {
            return [];
          }
          return ismOverrides.map((ismOverride) =>
            this.icaApp.getAccount(destinationChain, {
              origin: originChain,
              owner: bytes32ToAddress(owner),
              userSalt,
              localRouter,
              routerOverride,
              ismOverride,
            }),
          );
        }),
      ),
    ]);
    const routerVersionIcas: string[] = [];
    let failedCandidates = 0;
    for (const result of versionResults) {
      if (result.status === 'fulfilled') {
        routerVersionIcas.push(result.value);
      } else {
        failedCandidates++;
        log.warn(
          {
            originTxHash,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
          'Could not derive the ICA for a router version',
        );
      }
    }
    return { ica, routerVersionIcas, failedCandidates };
  }

  /**
   * Validate and parse the request body against the Zod schema.
   * Returns parsed data or sends a 400 response and returns null.
   */
  private parseCommitmentBody(
    body: unknown,
    res: FastifyReply,
    logger: Logger,
  ) {
    const result = PostCallsSchema.safeParse(body);
    if (!result.success) {
      const errors = z.treeifyError(result.error);
      logger.warn({ errors }, 'Invalid request body received');
      res.code(400).send({ errors });
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
      select: { commitment: true, ...commitmentReconciliationSelect },
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
      localRouter: data.localRouter,
      routerOverride: data.routerOverride,
      ismOverride: data.ismOverride,
      userSalt: data.userSalt,
    };

    logger.debug(
      {
        originChain,
        destinationChain,
        owner: data.owner,
        localRouter: data.localRouter,
        routerOverride: data.routerOverride,
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
  public async handleCheckCommitment(
    req: CcipRequest<{ Params: CommitmentParams }>,
    res: FastifyReply,
  ) {
    const logger = this.addLoggerServiceContext(req.log);
    const { commitment } = req.params;
    assert(commitment, 'Route parameter :commitment must be present');
    res.header('Cache-Control', 'no-store');
    try {
      const record = await prisma.commitment.findUnique({
        where: { commitment },
        select: { ica: true, originDomain: true },
      });
      if (record === null) return res.send({ exists: false });

      const metadata = CommitmentRoutingSchema.parse(record);
      return res.send({
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
      return res.code(500).send({ error: 'Internal server error' });
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

  private static readonly CalldataPostSchema = z.compile(
    z.object({
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
      relayers: z.array(CcsSignerSchema).default([]),
      destinationAccount: z
        .string()
        .regex(
          /^0x[0-9a-fA-F]{64}$/,
          'destinationAccount must be a 32-byte 0x hex string',
        ),
      revealAccounts: z
        .array(CallCommitmentsService.RevealAccountSchema)
        .optional(),
    }),
  );

  public async handleCalldataPost(req: CcipRequest, res: FastifyReply) {
    const logger = this.addLoggerServiceContext(req.log);
    const result = CallCommitmentsService.CalldataPostSchema.safeParse(
      req.body,
    );
    if (!result.success) {
      return res.code(400).send({ errors: z.treeifyError(result.error) });
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
        .code(400)
        .send({ error: 'commitment does not match keccak256(salt || data)' });
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
          .code(409)
          .send({ error: 'Commitment already exists with different metadata' });
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
      return res.code(500).send({ error: 'Internal server error' });
    }

    return res.code(200).send({ commitment });
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

  public async handleCalldataGet(
    req: CcipRequest<{ Params: CommitmentParams }>,
    res: FastifyReply,
  ) {
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
      record = await prisma.calldata.findUnique({
        where: { commitment },
        select: calldataMetadataSelect,
      });
    } catch (error: unknown) {
      logger.error(
        {
          commitment,
          error: error instanceof Error ? error.message : String(error),
        },
        'Database error fetching calldata',
      );
      return res.code(500).send({ error: 'Internal server error' });
    }
    if (!record) return res.code(404).send({ error: 'Not found' });
    const relayers = z.array(z.string()).parse(record.relayers);
    if (!isAuthorizedRelayer(relayers, this.auth.signer(req))) {
      return res
        .code(403)
        .send({ error: 'Signer not authorized for this commitment' });
    }

    return res.code(200).send({
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

  registerRoutes(app: CcipApp, prefix: string): void {
    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });

    const writeRateLimit = { preHandler: createRateLimitHook(app, 'write') };
    const readRateLimit = { preHandler: createRateLimitHook(app, 'read') };

    app.post(
      `${prefix}${RateLimitedRoute.Calls}`,
      writeRateLimit,
      this.handleCommitment.bind(this),
    );
    app.get<{ Params: CommitmentParams }>(
      `${prefix}${RateLimitedRoute.CallsByCommitment}`,
      readRateLimit,
      this.handleCheckCommitment.bind(this),
    );
    app.post(
      `${prefix}${RateLimitedRoute.Calldata}`,
      writeRateLimit,
      this.handleCalldataPost.bind(this),
    );
    // GET /calldata/:commitment is disabled by default while the Sealevel
    // reveal flow is redesigned.
    if (this.calldataLookupEnabled) {
      app.get<{ Params: CommitmentParams }>(
        `${prefix}${RateLimitedRoute.CalldataByCommitment}`,
        { preHandler: [readRateLimit.preHandler, this.auth.authenticate] },
        this.handleCalldataGet.bind(this),
      );
    }
    app.post<AbiRoute>(
      `${prefix}/getCallsFromRevealMessage`,
      { ...ABI_ROUTE_OPTIONS, preHandler: this.auth.authenticate },
      async (request, reply) => {
        const rawTxHash = request.body?.origin_tx_hash;
        if (
          typeof rawTxHash === 'string' &&
          !utils.isHexString(rawTxHash, 32)
        ) {
          return reply.code(400).send({ error: 'Invalid origin_tx_hash' });
        }
        const originTxHash =
          typeof rawTxHash === 'string' && utils.isHexString(rawTxHash, 32)
            ? rawTxHash
            : undefined;
        return createAbiHandler(
          CommitmentReadIsmService__factory,
          'getCallsFromRevealMessage',
          (message: string, relayer: string, logger: Logger) =>
            this.handleFetchCommitment(message, relayer, logger, originTxHash),
          {
            skipResultEncoding: true,
            authenticatedRelayer: (request) => this.auth.signer(request),
          },
        )(request, reply);
      },
    );
  }
}
