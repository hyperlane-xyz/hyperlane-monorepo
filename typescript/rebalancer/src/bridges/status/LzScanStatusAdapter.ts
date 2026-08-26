import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { z } from 'zod';

import { assert, eqAddress, isAddressEvm } from '@hyperlane-xyz/utils';

import { TokenBridgeStatusAdapterType } from '../../config/types.js';
import type {
  ITokenBridgeStatusAdapter,
  MCRExecutionContext,
  MCRSettlementStatus,
  MCRStatusPollContext,
  MCRStatusRef,
} from '../../interfaces/ITokenBridgeStatusAdapter.js';

const DEFAULT_API_URL = 'https://scan.layerzero-api.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const BYTES32_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const EVM_ADDRESS_SCHEMA = z.string().refine(isAddressEvm);

const OFT_SENT_INTERFACE = new ethers.utils.Interface([
  'event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)',
]);
const OFT_SENT_TOPIC =
  OFT_SENT_INTERFACE.getEventTopic('OFTSent').toLowerCase();
const OFT_RECEIVED_INTERFACE = new ethers.utils.Interface([
  'event OFTReceived(bytes32 indexed guid,uint32 srcEid,address indexed toAddress,uint256 amountReceivedLD)',
]);
const OFT_RECEIVED_TOPIC =
  OFT_RECEIVED_INTERFACE.getEventTopic('OFTReceived').toLowerCase();

interface LzScanRefData extends Record<string, unknown> {
  originTxHash: string;
  destination: string;
  destinationDomain: number;
  guid?: string;
  sourceEid?: number;
  destinationEid?: number;
  sourceOft?: string;
  destinationOft?: string;
  destinationRecipient?: string;
  amountReceivedLD?: string;
  minimumDestinationAmount?: string;
  trackingError?: string;
  lastObservedStatus?: string;
  lastPolledAt?: number;
}

const LayerZeroStatusSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);

const LayerZeroMessageSchema = z
  .object({
    guid: BYTES32_SCHEMA,
    pathway: z
      .object({
        srcEid: z.number().int().positive(),
        dstEid: z.number().int().positive(),
        sender: z.object({ address: EVM_ADDRESS_SCHEMA }).passthrough(),
        receiver: z.object({ address: EVM_ADDRESS_SCHEMA }).passthrough(),
      })
      .passthrough(),
    source: z
      .object({
        tx: z.object({ txHash: BYTES32_SCHEMA }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    status: LayerZeroStatusSchema,
    destination: z
      .object({
        status: z.string().optional(),
        tx: z.object({ txHash: BYTES32_SCHEMA }).passthrough().optional(),
        lzCompose: z
          .object({
            status: z.string(),
            txs: z
              .array(z.object({ txHash: z.string() }).passthrough())
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const LayerZeroResponseSchema = z
  .object({
    data: z.array(LayerZeroMessageSchema).optional(),
    messages: z.array(LayerZeroMessageSchema).optional(),
  })
  .passthrough();

type LayerZeroMessage = z.infer<typeof LayerZeroMessageSchema>;
type LayerZeroResponse = z.infer<typeof LayerZeroResponseSchema>;

export interface LzScanStatusAdapterOptions {
  apiUrl?: string;
  logger: Logger;
  maxRetries?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}

/** Tracks a source-committed LayerZero OFT movement through destination execution. */
export class LzScanStatusAdapter implements ITokenBridgeStatusAdapter {
  readonly kind = TokenBridgeStatusAdapterType.LayerZeroScan;
  readonly logger: Logger;
  private readonly apiUrl: string;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: LzScanStatusAdapterOptions) {
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    assert(this.maxRetries > 0, 'LayerZero Scan maxRetries must be positive');
    assert(
      this.requestTimeoutMs > 0,
      'LayerZero Scan requestTimeoutMs must be positive',
    );
    assert(
      this.retryDelayMs >= 0,
      'LayerZero Scan retryDelayMs must be non-negative',
    );
  }

  async initFromReceipt(ctx: MCRExecutionContext): Promise<MCRStatusRef> {
    const originTxHash = normalizeTxHash(ctx.receipt.transactionHash);
    const {
      sourceEid,
      destinationEid,
      sourceOft,
      destinationOft,
      destinationRecipient,
      sourceTokenDecimals,
      destinationTokenDecimals,
      minimumDestinationAmount,
    } = ctx;
    const hasRouteIdentity =
      sourceEid !== undefined &&
      destinationEid !== undefined &&
      sourceOft !== undefined &&
      destinationOft !== undefined &&
      destinationRecipient !== undefined &&
      sourceTokenDecimals !== undefined &&
      destinationTokenDecimals !== undefined &&
      minimumDestinationAmount !== undefined;
    const oftSentEvents = (ctx.receipt.logs ?? [])
      .filter(
        (log) =>
          hasRouteIdentity &&
          log.topics[0]?.toLowerCase() === OFT_SENT_TOPIC &&
          sourceOft !== undefined &&
          eqAddress(log.address, sourceOft),
      )
      .flatMap((log) => {
        try {
          if (
            sourceTokenDecimals === undefined ||
            destinationTokenDecimals === undefined
          ) {
            return [];
          }
          const parsed = OFT_SENT_INTERFACE.parseLog(log);
          const parsedDestinationEid = Number(parsed.args.dstEid);
          const fromAddress = String(parsed.args.fromAddress);
          if (
            parsedDestinationEid !== destinationEid ||
            !eqAddress(fromAddress, ctx.bridge)
          ) {
            return [];
          }
          const amountReceivedLD = scaleLocalAmount(
            String(parsed.args.amountReceivedLD),
            sourceTokenDecimals,
            destinationTokenDecimals,
          );
          if (
            minimumDestinationAmount === undefined ||
            BigInt(amountReceivedLD) < minimumDestinationAmount
          ) {
            return [];
          }
          return [
            {
              amountReceivedLD,
              destinationEid: parsedDestinationEid,
              guid: String(parsed.args.guid),
            },
          ];
        } catch {
          return [];
        }
      });

    const event = oftSentEvents.length === 1 ? oftSentEvents[0] : undefined;
    const data: LzScanRefData = {
      originTxHash,
      destination: ctx.destination,
      destinationDomain: ctx.destinationDomain,
      sourceEid,
      destinationEid,
      sourceOft,
      destinationOft,
      destinationRecipient,
      minimumDestinationAmount: minimumDestinationAmount?.toString(),
      ...(event
        ? {
            guid: event.guid,
            amountReceivedLD: event.amountReceivedLD,
          }
        : {
            trackingError: !hasRouteIdentity
              ? 'LayerZero route identity missing'
              : oftSentEvents.length === 0
                ? 'Matching OFTSent event not found'
                : 'Multiple OFTSent events found',
          }),
    };

    if (!event) {
      this.logger.error(
        {
          originTxHash,
          oftSentEventCount: oftSentEvents.length,
          destination: ctx.destination,
        },
        'LayerZero transfer is source-committed but cannot be tracked automatically',
      );
    }

    return { provider: this.kind, kind: this.kind, data };
  }

  async pollStatus(
    ref: MCRStatusRef,
    ctx: MCRStatusPollContext,
  ): Promise<MCRSettlementStatus> {
    const data = parseRefData(ref);
    const now = Date.now();

    // A confirmed source transaction must remain suppressed if its exact GUID
    // cannot be recovered. Manual reconciliation is safer than a duplicate send.
    if (
      !data.guid ||
      data.sourceEid === undefined ||
      data.destinationEid === undefined ||
      !data.sourceOft ||
      !data.destinationOft ||
      !data.destinationRecipient ||
      !data.amountReceivedLD
    ) {
      return {
        status: 'pending',
        substatus: 'MANUAL_RECONCILIATION_REQUIRED',
        ref: this.refreshRef(ref, data, now),
      };
    }

    const { guid, sourceEid, destinationEid, sourceOft, destinationOft } = data;

    let response: LayerZeroResponse;
    try {
      response = await this.fetchMessage(guid);
    } catch (error) {
      this.logger.warn(
        { guid, originTxHash: data.originTxHash, error },
        'LayerZero Scan lookup failed; treating settlement as pending',
      );
      return { status: 'pending', ref: this.refreshRef(ref, data, now) };
    }

    const messages = response.data ?? response.messages ?? [];
    const message = messages.find(
      (candidate) =>
        equalHex(candidate.guid, guid) &&
        candidate.pathway.srcEid === sourceEid &&
        candidate.pathway.dstEid === destinationEid &&
        eqAddress(candidate.pathway.sender.address, sourceOft) &&
        eqAddress(candidate.pathway.receiver.address, destinationOft) &&
        candidate.source?.tx?.txHash !== undefined &&
        equalHex(candidate.source.tx.txHash, data.originTxHash),
    );
    if (!message) {
      return {
        status: 'pending',
        substatus: 'EXACT_MESSAGE_NOT_FOUND',
        ref: this.refreshRef(ref, data, now),
      };
    }

    return this.evaluateMessage(ref, data, message, now, ctx);
  }

  protected async fetchMessage(guid: string): Promise<LayerZeroResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * Math.pow(2, attempt - 1)),
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );
      try {
        const response = await fetch(
          `${this.apiUrl}/messages/guid/${encodeURIComponent(guid)}`,
          {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          },
        );
        if (response.status === 404) return { data: [] };
        if (!response.ok) {
          throw new Error(
            `LayerZero Scan API error: ${response.status} ${response.statusText}`,
          );
        }
        return LayerZeroResponseSchema.parse(await response.json());
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  private async evaluateMessage(
    ref: MCRStatusRef,
    data: LzScanRefData,
    message: LayerZeroMessage,
    now: number,
    ctx: MCRStatusPollContext,
  ): Promise<MCRSettlementStatus> {
    const overallStatus = normalizeStatus(message.status);
    const destinationStatus = normalizeStatus(message.destination?.status);
    const composeStatus = normalizeStatus(
      message.destination?.lzCompose?.status,
    );
    const observedStatus = [overallStatus, destinationStatus, composeStatus]
      .filter(Boolean)
      .join('/');
    const refreshed = this.refreshRef(
      ref,
      data,
      now,
      observedStatus || 'UNKNOWN',
    );

    const composeSatisfied =
      !composeStatus ||
      composeStatus === 'N/A' ||
      composeStatus === 'SUCCEEDED';
    const receivingTxHash = message.destination?.tx?.txHash;
    if (
      overallStatus === 'DELIVERED' &&
      destinationStatus === 'SUCCEEDED' &&
      composeSatisfied &&
      receivingTxHash
    ) {
      if (
        await this.verifyDestinationReceipt(receivingTxHash, data, message, ctx)
      ) {
        return { status: 'complete', receivingTxHash, ref: refreshed };
      }
      return {
        status: 'pending',
        substatus: 'DESTINATION_RECEIPT_UNVERIFIED',
        ref: refreshed,
      };
    }

    // The source collateral move is already committed. Even irrecoverable or
    // retryable LayerZero failures require operator reconciliation; releasing
    // the intent here could debit collateral a second time.
    return {
      status: 'pending',
      substatus: observedStatus || 'UNKNOWN',
      ref: refreshed,
    };
  }

  private async verifyDestinationReceipt(
    receivingTxHash: string,
    data: LzScanRefData,
    message: LayerZeroMessage,
    ctx: MCRStatusPollContext,
  ): Promise<boolean> {
    if (
      !data.guid ||
      data.sourceEid === undefined ||
      !data.destinationOft ||
      !data.destinationRecipient ||
      !data.amountReceivedLD
    ) {
      return false;
    }
    const {
      guid,
      sourceEid,
      destinationOft,
      destinationRecipient,
      amountReceivedLD,
    } = data;

    try {
      const chainName = ctx.core.multiProvider.getChainName(ctx.destination);
      const provider = ctx.core.multiProvider.getEthersV5Provider(chainName);
      const receipt = await provider.getTransactionReceipt(
        normalizeTxHash(receivingTxHash),
      );
      if (!receipt || receipt.status !== 1) return false;

      const blocks = ctx.core.metadata(chainName).blocks;
      const minimumConfirmations = blocks?.confirmations ?? 1;
      if (receipt.confirmations < minimumConfirmations) return false;

      if (
        typeof ctx.blockTag === 'number' &&
        receipt.blockNumber > ctx.blockTag
      ) {
        return false;
      }

      const reorgPeriod = blocks?.reorgPeriod;
      const finalityTag =
        typeof ctx.blockTag === 'string'
          ? ctx.blockTag
          : typeof reorgPeriod === 'string'
            ? reorgPeriod
            : undefined;
      if (finalityTag) {
        const confirmedBlock = await provider.getBlock(finalityTag);
        if (!confirmedBlock || receipt.blockNumber > confirmedBlock.number) {
          return false;
        }
      }

      if (
        typeof reorgPeriod === 'number' &&
        receipt.confirmations < reorgPeriod
      ) {
        return false;
      }

      const matchingEvents = receipt.logs.filter((log) => {
        if (
          log.topics[0]?.toLowerCase() !== OFT_RECEIVED_TOPIC ||
          !eqAddress(log.address, destinationOft)
        ) {
          return false;
        }
        try {
          const parsed = OFT_RECEIVED_INTERFACE.parseLog(log);
          return (
            equalHex(String(parsed.args.guid), guid) &&
            Number(parsed.args.srcEid) === message.pathway.srcEid &&
            Number(parsed.args.srcEid) === sourceEid &&
            eqAddress(String(parsed.args.toAddress), destinationRecipient) &&
            String(parsed.args.amountReceivedLD) === amountReceivedLD
          );
        } catch {
          return false;
        }
      });
      return matchingEvents.length === 1;
    } catch (error) {
      this.logger.warn(
        { receivingTxHash, destination: data.destination, error },
        'Failed to verify LayerZero destination receipt',
      );
      return false;
    }
  }

  private refreshRef(
    ref: MCRStatusRef,
    data: LzScanRefData,
    lastPolledAt: number,
    lastObservedStatus?: string,
  ): MCRStatusRef {
    return {
      ...ref,
      data: {
        ...data,
        lastPolledAt,
        ...(lastObservedStatus ? { lastObservedStatus } : {}),
      },
    };
  }
}

function parseRefData(ref: MCRStatusRef): LzScanRefData {
  return z
    .object({
      originTxHash: BYTES32_SCHEMA,
      destination: z.string().min(1),
      destinationDomain: z.number(),
      guid: BYTES32_SCHEMA.optional(),
      sourceEid: z.number().int().positive().optional(),
      destinationEid: z.number().int().positive().optional(),
      sourceOft: EVM_ADDRESS_SCHEMA.optional(),
      destinationOft: EVM_ADDRESS_SCHEMA.optional(),
      destinationRecipient: EVM_ADDRESS_SCHEMA.optional(),
      amountReceivedLD: z.string().regex(/^\d+$/).optional(),
      minimumDestinationAmount: z.string().regex(/^\d+$/).optional(),
      trackingError: z.string().optional(),
      lastObservedStatus: z.string().optional(),
      lastPolledAt: z.number().optional(),
    })
    .passthrough()
    .parse(ref.data);
}

function normalizeStatus(status?: string | { name: string }): string {
  return (
    (typeof status === 'string' ? status : status?.name)
      ?.trim()
      .toUpperCase() ?? ''
  );
}

function equalHex(left: string, right: string): boolean {
  return (
    left.replace(/^0x/i, '').toLowerCase() ===
    right.replace(/^0x/i, '').toLowerCase()
  );
}

function scaleLocalAmount(
  amount: string,
  sourceDecimals: number,
  destinationDecimals: number,
): string {
  assert(
    Number.isInteger(sourceDecimals) && sourceDecimals >= 0,
    'Invalid source token decimals',
  );
  assert(
    Number.isInteger(destinationDecimals) && destinationDecimals >= 0,
    'Invalid destination token decimals',
  );

  const value = BigInt(amount);
  if (sourceDecimals === destinationDecimals) return value.toString();
  if (sourceDecimals < destinationDecimals) {
    return (
      value *
      10n ** BigInt(destinationDecimals - sourceDecimals)
    ).toString();
  }

  const divisor = 10n ** BigInt(sourceDecimals - destinationDecimals);
  assert(value % divisor === 0n, 'LayerZero OFT amount contains local dust');
  return (value / divisor).toString();
}

export function normalizeTxHash(txHash: string): string {
  return /^0x/i.test(txHash) ? `0x${txHash.slice(2)}` : `0x${txHash}`;
}
