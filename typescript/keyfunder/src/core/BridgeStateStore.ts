import { BigNumber } from 'ethers';
import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, eqAddress, sleep } from '@hyperlane-xyz/utils';

import {
  ArbitrumOrbitBridgeMode,
  type BridgeConfig,
  BridgeStack,
  OpStackBridgeMode,
} from '../config/types.js';

import {
  BridgeDeliveryKind,
  type BridgeDeliveryRef,
  checkBridgeDeliveryStatus,
  extractBridgeDeliveryRefFromReceipt,
  fetchTransactionReceipt,
} from './BridgeDelivery.js';

export type BridgeAttemptPhase = 'prepared' | 'submitted' | 'confirmed';
export type BridgeBroadcastStage =
  | 'before_attempt'
  | 'attempting'
  | 'submitted';

export interface PersistedBridgeAttempt {
  originChain: string;
  destinationChain: string;
  recipient: string;
  funderAddress: string;
  stack: BridgeConfig['stack'];
  mode: BridgeConfig['mode'];
  /** Expected destination credit in destination base units (decimal string). */
  bridgedAmount: string;
  /** Destination balance read immediately before bridging (decimal string). */
  baselineDestinationBalance: string;
  /** Native value attached on the origin chain in origin native wei (decimal string). */
  originNativeValue: string;
  /** Prepared gas fee budget on the origin chain in origin native wei (decimal string). */
  originGasBudget: string;
  /** Nonce assigned to the deposit transaction that is signed and broadcast. */
  originNonce?: number;
  /** Broadcast lifecycle stage distinguishing unsent vs in-flight vs submitted. */
  broadcastStage: BridgeBroadcastStage;
  /** Pre-signed raw deposit transaction hex when available, allowing safe rebroadcast. */
  signedTransaction?: string;
  /** Origin deposit transaction hash (precomputed signed hash or broadcast hash). */
  depositTxHash?: string;
  /** Protocol-specific destination delivery locator extracted from the origin receipt. */
  deliveryRef?: BridgeDeliveryRef;
  /** Any completed ERC20 reset/approval transaction hashes on the origin chain. */
  approvalTxHashes: string[];
  phase: BridgeAttemptPhase;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BridgeStateStore {
  get(
    destinationChain: string,
    recipient: string,
  ): Promise<PersistedBridgeAttempt | undefined>;
  set(attempt: PersistedBridgeAttempt): Promise<void>;
  delete(destinationChain: string, recipient: string): Promise<void>;
  listByOriginSigner(
    originChain: string,
    funderAddress: string,
  ): Promise<PersistedBridgeAttempt[]>;
}

function makeRecipientScopeKey(
  destinationChain: string,
  recipient: string,
): string {
  return `${destinationChain}:${recipient.toLowerCase()}`;
}

function cloneAttempt(attempt: PersistedBridgeAttempt): PersistedBridgeAttempt {
  return {
    ...attempt,
    approvalTxHashes: [...attempt.approvalTxHashes],
    ...(attempt.deliveryRef ? { deliveryRef: { ...attempt.deliveryRef } } : {}),
  };
}

const VALID_PHASES = new Set<string>(['prepared', 'submitted', 'confirmed']);
const VALID_STAGES = new Set<string>([
  'before_attempt',
  'attempting',
  'submitted',
]);
const VALID_MODES = new Set<string>([
  ...Object.values(OpStackBridgeMode),
  ...Object.values(ArbitrumOrbitBridgeMode),
]);
const DECIMAL_UINT_REGEX = /^\d+$/;

function isBridgeAttemptPhase(value: unknown): value is BridgeAttemptPhase {
  return typeof value === 'string' && VALID_PHASES.has(value);
}

function isBridgeBroadcastStage(value: unknown): value is BridgeBroadcastStage {
  return typeof value === 'string' && VALID_STAGES.has(value);
}

function isBridgeMode(value: unknown): value is BridgeConfig['mode'] {
  return typeof value === 'string' && VALID_MODES.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDeliveryRef(
  recordKey: string,
  raw: unknown,
): BridgeDeliveryRef | undefined {
  if (raw === undefined) {
    return undefined;
  }
  assert(
    isPlainRecord(raw),
    `Invalid bridge state record "${recordKey}": deliveryRef must be an object`,
  );
  const kind = raw.kind;
  if (kind === BridgeDeliveryKind.OpStackDeposit) {
    assert(
      typeof raw.l2TxHash === 'string' && raw.l2TxHash.length > 0,
      `Invalid bridge state record "${recordKey}": missing opStackDeposit l2TxHash`,
    );
    return { kind: BridgeDeliveryKind.OpStackDeposit, l2TxHash: raw.l2TxHash };
  }
  if (kind === BridgeDeliveryKind.ArbitrumDeposit) {
    assert(
      typeof raw.childTxHash === 'string' && raw.childTxHash.length > 0,
      `Invalid bridge state record "${recordKey}": missing arbitrumDeposit childTxHash`,
    );
    return {
      kind: BridgeDeliveryKind.ArbitrumDeposit,
      childTxHash: raw.childTxHash,
    };
  }
  if (kind === BridgeDeliveryKind.ArbitrumRetryable) {
    assert(
      typeof raw.retryableCreationId === 'string' &&
        raw.retryableCreationId.length > 0,
      `Invalid bridge state record "${recordKey}": missing arbitrumRetryable retryableCreationId`,
    );
    return {
      kind: BridgeDeliveryKind.ArbitrumRetryable,
      retryableCreationId: raw.retryableCreationId,
    };
  }
  if (kind === BridgeDeliveryKind.HyperlaneMessage) {
    assert(
      typeof raw.messageId === 'string' && raw.messageId.length > 0,
      `Invalid bridge state record "${recordKey}": missing hyperlaneMessage messageId`,
    );
    assert(
      raw.destinationMailboxAddress === undefined ||
        typeof raw.destinationMailboxAddress === 'string',
      `Invalid bridge state record "${recordKey}": invalid destinationMailboxAddress`,
    );
    return {
      kind: BridgeDeliveryKind.HyperlaneMessage,
      messageId: raw.messageId,
      ...(raw.destinationMailboxAddress !== undefined
        ? { destinationMailboxAddress: raw.destinationMailboxAddress }
        : {}),
    };
  }
  throw new Error(
    `Invalid bridge state record "${recordKey}": unsupported deliveryRef kind "${String(kind)}"`,
  );
}

function parsePersistedAttempt(
  recordKey: string,
  raw: unknown,
): PersistedBridgeAttempt {
  assert(
    isPlainRecord(raw),
    `Invalid bridge state record "${recordKey}": expected object`,
  );
  assert(
    typeof raw.originChain === 'string' && raw.originChain.length > 0,
    `Invalid bridge state record "${recordKey}": missing originChain`,
  );
  assert(
    typeof raw.destinationChain === 'string' && raw.destinationChain.length > 0,
    `Invalid bridge state record "${recordKey}": missing destinationChain`,
  );
  assert(
    typeof raw.recipient === 'string' && raw.recipient.length > 0,
    `Invalid bridge state record "${recordKey}": missing recipient`,
  );
  assert(
    typeof raw.funderAddress === 'string' && raw.funderAddress.length > 0,
    `Invalid bridge state record "${recordKey}": missing funderAddress`,
  );
  assert(
    raw.stack === BridgeStack.OpStack ||
      raw.stack === BridgeStack.ArbitrumOrbit,
    `Invalid bridge state record "${recordKey}": invalid stack`,
  );
  assert(
    isBridgeMode(raw.mode),
    `Invalid bridge state record "${recordKey}": invalid mode`,
  );
  assert(
    typeof raw.bridgedAmount === 'string' &&
      DECIMAL_UINT_REGEX.test(raw.bridgedAmount),
    `Invalid bridge state record "${recordKey}": invalid bridgedAmount`,
  );
  assert(
    typeof raw.baselineDestinationBalance === 'string' &&
      DECIMAL_UINT_REGEX.test(raw.baselineDestinationBalance),
    `Invalid bridge state record "${recordKey}": invalid baselineDestinationBalance`,
  );
  assert(
    typeof raw.originNativeValue === 'string' &&
      DECIMAL_UINT_REGEX.test(raw.originNativeValue),
    `Invalid bridge state record "${recordKey}": invalid originNativeValue`,
  );
  assert(
    typeof raw.originGasBudget === 'string' &&
      DECIMAL_UINT_REGEX.test(raw.originGasBudget),
    `Invalid bridge state record "${recordKey}": invalid originGasBudget`,
  );
  assert(
    raw.originNonce === undefined ||
      (typeof raw.originNonce === 'number' &&
        Number.isInteger(raw.originNonce) &&
        raw.originNonce >= 0),
    `Invalid bridge state record "${recordKey}": invalid originNonce`,
  );
  assert(
    isBridgeAttemptPhase(raw.phase),
    `Invalid bridge state record "${recordKey}": invalid phase`,
  );
  const phase = raw.phase;
  const stageRaw =
    raw.broadcastStage ??
    (phase === 'submitted' || phase === 'confirmed'
      ? 'submitted'
      : 'attempting');
  assert(
    isBridgeBroadcastStage(stageRaw),
    `Invalid bridge state record "${recordKey}": invalid broadcastStage`,
  );
  assert(
    raw.signedTransaction === undefined ||
      typeof raw.signedTransaction === 'string',
    `Invalid bridge state record "${recordKey}": invalid signedTransaction`,
  );
  assert(
    raw.depositTxHash === undefined || typeof raw.depositTxHash === 'string',
    `Invalid bridge state record "${recordKey}": invalid depositTxHash`,
  );
  assert(
    Array.isArray(raw.approvalTxHashes) &&
      raw.approvalTxHashes.every((item) => typeof item === 'string'),
    `Invalid bridge state record "${recordKey}": approvalTxHashes must be a string array`,
  );
  assert(
    typeof raw.createdAtMs === 'number' && Number.isFinite(raw.createdAtMs),
    `Invalid bridge state record "${recordKey}": invalid createdAtMs`,
  );
  assert(
    typeof raw.updatedAtMs === 'number' && Number.isFinite(raw.updatedAtMs),
    `Invalid bridge state record "${recordKey}": invalid updatedAtMs`,
  );

  const deliveryRef = parseDeliveryRef(recordKey, raw.deliveryRef);

  return {
    originChain: raw.originChain,
    destinationChain: raw.destinationChain,
    recipient: raw.recipient,
    funderAddress: raw.funderAddress,
    stack: raw.stack,
    mode: raw.mode,
    bridgedAmount: raw.bridgedAmount,
    baselineDestinationBalance: raw.baselineDestinationBalance,
    originNativeValue: raw.originNativeValue,
    originGasBudget: raw.originGasBudget,
    ...(raw.originNonce !== undefined ? { originNonce: raw.originNonce } : {}),
    broadcastStage: stageRaw,
    ...(raw.signedTransaction !== undefined
      ? { signedTransaction: raw.signedTransaction }
      : {}),
    ...(raw.depositTxHash !== undefined
      ? { depositTxHash: raw.depositTxHash }
      : {}),
    ...(deliveryRef !== undefined ? { deliveryRef } : {}),
    approvalTxHashes: [...raw.approvalTxHashes],
    phase,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

export class InMemoryBridgeStateStore implements BridgeStateStore {
  private readonly attempts = new Map<string, PersistedBridgeAttempt>();

  async get(
    destinationChain: string,
    recipient: string,
  ): Promise<PersistedBridgeAttempt | undefined> {
    const entry = this.attempts.get(
      makeRecipientScopeKey(destinationChain, recipient),
    );
    return entry ? cloneAttempt(entry) : undefined;
  }

  async set(attempt: PersistedBridgeAttempt): Promise<void> {
    this.attempts.set(
      makeRecipientScopeKey(attempt.destinationChain, attempt.recipient),
      cloneAttempt(attempt),
    );
  }

  async delete(destinationChain: string, recipient: string): Promise<void> {
    this.attempts.delete(makeRecipientScopeKey(destinationChain, recipient));
  }

  async listByOriginSigner(
    originChain: string,
    funderAddress: string,
  ): Promise<PersistedBridgeAttempt[]> {
    const matches: PersistedBridgeAttempt[] = [];
    for (const entry of this.attempts.values()) {
      if (
        entry.originChain === originChain &&
        eqAddress(entry.funderAddress, funderAddress)
      ) {
        matches.push(cloneAttempt(entry));
      }
    }
    return matches;
  }
}

interface SerializedBridgeStateFile {
  version: 1;
  attempts: Record<string, PersistedBridgeAttempt | undefined>;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 15;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    return code === 'EPERM';
  }
}

export class FileBridgeStateStore implements BridgeStateStore {
  private writeLock: Promise<void> = Promise.resolve();
  private tempCounter = 0;

  constructor(private readonly filePath: string) {}

  private get lockFilePath(): string {
    return `${this.filePath}.lock`;
  }

  private async acquireInterprocessLock(): Promise<() => void> {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const fd = fs.openSync(this.lockFilePath, 'wx', 0o600);
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
            'utf8',
          );
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return () => {
          try {
            fs.unlinkSync(this.lockFilePath);
          } catch {
            // Lock already removed
          }
        };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        if (code !== 'EEXIST') {
          throw error;
        }

        try {
          const lockRaw = fs.readFileSync(this.lockFilePath, 'utf8');
          const lockParsed: unknown = JSON.parse(lockRaw);
          if (
            isPlainRecord(lockParsed) &&
            typeof lockParsed.pid === 'number' &&
            !isProcessAlive(lockParsed.pid)
          ) {
            fs.unlinkSync(this.lockFilePath);
            continue;
          }
        } catch {
          // Concurrent holder may still be writing or releasing the lockfile
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out acquiring interprocess lock for bridge state file ${this.filePath}`,
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.writeLock.then(async () => {
      const releaseProcessLock = await this.acquireInterprocessLock();
      try {
        return await operation();
      } finally {
        releaseProcessLock();
      }
    });
    this.writeLock = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private readStateFromDisk(): SerializedBridgeStateFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, attempts: {} };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Failed to parse bridge state file at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    assert(
      isPlainRecord(parsed),
      `Invalid bridge state file at ${this.filePath}: root must be an object`,
    );
    assert(
      parsed.version === 1,
      `Unsupported bridge state file version at ${this.filePath}: expected 1, got ${String(parsed.version)}`,
    );
    assert(
      isPlainRecord(parsed.attempts),
      `Invalid bridge state file at ${this.filePath}: attempts must be an object`,
    );

    const validatedAttempts: Record<
      string,
      PersistedBridgeAttempt | undefined
    > = {};
    for (const [key, entry] of Object.entries(parsed.attempts)) {
      validatedAttempts[key] = parsePersistedAttempt(key, entry);
    }

    return {
      version: 1,
      attempts: validatedAttempts,
    };
  }

  private writeStateToDisk(state: SerializedBridgeStateFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.tempCounter += 1;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`;

    const tempFd = fs.openSync(tempPath, 'w', 0o600);
    try {
      fs.writeFileSync(tempFd, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }

    fs.renameSync(tempPath, this.filePath);

    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  }

  async get(
    destinationChain: string,
    recipient: string,
  ): Promise<PersistedBridgeAttempt | undefined> {
    return this.withExclusiveLock(async () => {
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(destinationChain, recipient);
      const entry = state.attempts[key];
      return entry ? cloneAttempt(entry) : undefined;
    });
  }

  async set(attempt: PersistedBridgeAttempt): Promise<void> {
    return this.withExclusiveLock(async () => {
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(
        attempt.destinationChain,
        attempt.recipient,
      );
      state.attempts[key] = cloneAttempt(attempt);
      this.writeStateToDisk(state);
    });
  }

  async delete(destinationChain: string, recipient: string): Promise<void> {
    return this.withExclusiveLock(async () => {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(destinationChain, recipient);
      if (Object.prototype.hasOwnProperty.call(state.attempts, key)) {
        delete state.attempts[key];
        this.writeStateToDisk(state);
      }
    });
  }

  async listByOriginSigner(
    originChain: string,
    funderAddress: string,
  ): Promise<PersistedBridgeAttempt[]> {
    return this.withExclusiveLock(async () => {
      const state = this.readStateFromDisk();
      const matches: PersistedBridgeAttempt[] = [];
      for (const entry of Object.values(state.attempts)) {
        if (
          entry?.originChain === originChain &&
          eqAddress(entry.funderAddress, funderAddress)
        ) {
          matches.push(cloneAttempt(entry));
        }
      }
      return matches;
    });
  }
}

const recipientBridgeLocks = new Map<string, Promise<void>>();

/**
 * Serializes funding/reconciliation per (destinationChain, recipient) so
 * overlapping timeout retries or shared-address roles cannot race.
 */
export async function withRecipientBridgeLock<T>(
  destinationChain: string,
  recipient: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = makeRecipientScopeKey(destinationChain, recipient);
  const previous = recipientBridgeLocks.get(key) ?? Promise.resolve();
  const execution = previous.then(operation);
  const settled = execution.then(
    () => undefined,
    () => undefined,
  );
  recipientBridgeLocks.set(key, settled);
  try {
    return await execution;
  } finally {
    if (recipientBridgeLocks.get(key) === settled) {
      recipientBridgeLocks.delete(key);
    }
  }
}

async function resolveFinalizedOriginNonce(
  multiProvider: MultiProvider,
  originChain: string,
  funderAddress: string,
): Promise<number | undefined> {
  const originProvider = multiProvider.getProvider(originChain);
  if (typeof originProvider.getTransactionCount !== 'function') {
    return undefined;
  }

  const metadata = multiProvider.getChainMetadata(originChain);
  const reorgPeriod = metadata.blocks?.reorgPeriod;
  const confirmations = metadata.blocks?.confirmations ?? 1;

  if (typeof reorgPeriod === 'string') {
    const count = await originProvider.getTransactionCount(
      funderAddress,
      reorgPeriod,
    );
    return typeof count === 'number' ? count : undefined;
  }

  const depth = Math.max(
    typeof reorgPeriod === 'number' ? reorgPeriod : 32,
    typeof confirmations === 'number' ? confirmations : 1,
    0,
  );

  if (depth > 0 && typeof originProvider.getBlockNumber === 'function') {
    const latestBlock = await originProvider.getBlockNumber();
    if (typeof latestBlock === 'number') {
      const finalizedHeight = Math.max(0, latestBlock - depth);
      const count = await originProvider.getTransactionCount(
        funderAddress,
        finalizedHeight,
      );
      return typeof count === 'number' ? count : undefined;
    }
  }

  const count = await originProvider.getTransactionCount(
    funderAddress,
    'finalized',
  );
  return typeof count === 'number' ? count : undefined;
}

function isBenignRebroadcastError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    msg.includes('already known') ||
    msg.includes('known transaction') ||
    msg.includes('nonce too low') ||
    msg.includes('already imported')
  );
}

/**
 * Reconciles a persisted bridge attempt against origin submission/finality and
 * deposit-specific destination delivery or terminal failure before retrying.
 */
export async function reconcilePendingBridgeAttempt(params: {
  multiProvider: MultiProvider;
  stateStore: BridgeStateStore;
  destinationChain: string;
  recipient: string;
  bridge?: BridgeConfig;
  logger: Logger;
}): Promise<PersistedBridgeAttempt | undefined> {
  const {
    multiProvider,
    stateStore,
    destinationChain,
    recipient,
    bridge,
    logger,
  } = params;

  let attempt = await stateStore.get(destinationChain, recipient);
  if (!attempt) {
    return undefined;
  }

  // If the process stopped before entering the broadcast callback, no network
  // send occurred regardless of subsequent account nonce activity.
  if (
    attempt.phase === 'prepared' &&
    attempt.broadcastStage === 'before_attempt' &&
    !attempt.depositTxHash
  ) {
    await stateStore.delete(destinationChain, recipient);
    return undefined;
  }

  const originProvider = multiProvider.getProvider(attempt.originChain);

  const checkDestinationDelivery = async (
    current: PersistedBridgeAttempt,
  ): Promise<PersistedBridgeAttempt | undefined> => {
    if (!current.deliveryRef) {
      return current;
    }
    const status = await checkBridgeDeliveryStatus({
      multiProvider,
      destinationChain,
      bridge,
      deliveryRef: current.deliveryRef,
    });
    if (status === 'delivered') {
      await stateStore.delete(destinationChain, recipient);
      logger.info(
        {
          originChain: current.originChain,
          destinationChain,
          depositTxHash: current.depositTxHash,
          deliveryRef: current.deliveryRef,
        },
        'Confirmed cross-chain bridge delivery on destination chain',
      );
      return undefined;
    }
    if (status === 'failed') {
      await stateStore.delete(destinationChain, recipient);
      logger.warn(
        {
          originChain: current.originChain,
          destinationChain,
          depositTxHash: current.depositTxHash,
          deliveryRef: current.deliveryRef,
        },
        'Cross-chain bridge deposit reached terminal failure on destination; clearing attempt for retry',
      );
      return undefined;
    }
    return current;
  };

  if (attempt.phase === 'confirmed' && attempt.deliveryRef) {
    return checkDestinationDelivery(attempt);
  }

  if (attempt.depositTxHash) {
    const receipt = await fetchTransactionReceipt(
      originProvider,
      attempt.depositTxHash,
    );

    if (receipt != null) {
      if (receipt.status === 0) {
        logger.warn(
          {
            originChain: attempt.originChain,
            destinationChain,
            depositTxHash: attempt.depositTxHash,
          },
          'Origin bridge deposit reverted; clearing persisted attempt for retry',
        );
        await stateStore.delete(destinationChain, recipient);
        return undefined;
      }

      let deliveryRef = attempt.deliveryRef;
      if (!deliveryRef && bridge) {
        const destMeta = multiProvider.getChainMetadata(destinationChain);
        const destChainId =
          typeof destMeta.chainId === 'number' ? destMeta.chainId : undefined;
        deliveryRef = extractBridgeDeliveryRefFromReceipt({
          receipt,
          bridge,
          destinationChainId: destChainId,
        });
      }

      if (
        attempt.phase !== 'confirmed' ||
        (deliveryRef && !attempt.deliveryRef)
      ) {
        attempt = {
          ...attempt,
          phase: 'confirmed',
          broadcastStage: 'submitted',
          ...(deliveryRef ? { deliveryRef } : {}),
          updatedAtMs: Date.now(),
        };
        await stateStore.set(attempt);
      }

      return checkDestinationDelivery(attempt);
    }

    const knownTx =
      typeof originProvider.getTransaction === 'function'
        ? await originProvider.getTransaction(attempt.depositTxHash)
        : undefined;
    if (knownTx != null) {
      if (attempt.phase === 'prepared') {
        attempt = {
          ...attempt,
          phase: 'submitted',
          broadcastStage: 'submitted',
          updatedAtMs: Date.now(),
        };
        await stateStore.set(attempt);
      }
      return attempt;
    }

    if (attempt.originNonce !== undefined) {
      const finalizedNonce = await resolveFinalizedOriginNonce(
        multiProvider,
        attempt.originChain,
        attempt.funderAddress,
      );
      if (
        finalizedNonce !== undefined &&
        finalizedNonce > attempt.originNonce
      ) {
        // Re-read receipt after observing finalized nonce advancement so a race
        // where this exact deposit just finalized is never misclassified.
        const postFinalityReceipt = await fetchTransactionReceipt(
          originProvider,
          attempt.depositTxHash,
        );
        if (postFinalityReceipt != null) {
          if (postFinalityReceipt.status === 0) {
            await stateStore.delete(destinationChain, recipient);
            return undefined;
          }
          let deliveryRef = attempt.deliveryRef;
          if (!deliveryRef && bridge) {
            const destMeta = multiProvider.getChainMetadata(destinationChain);
            const destChainId =
              typeof destMeta.chainId === 'number'
                ? destMeta.chainId
                : undefined;
            deliveryRef = extractBridgeDeliveryRefFromReceipt({
              receipt: postFinalityReceipt,
              bridge,
              destinationChainId: destChainId,
            });
          }
          attempt = {
            ...attempt,
            phase: 'confirmed',
            broadcastStage: 'submitted',
            ...(deliveryRef ? { deliveryRef } : {}),
            updatedAtMs: Date.now(),
          };
          await stateStore.set(attempt);
          return checkDestinationDelivery(attempt);
        }

        logger.warn(
          {
            originChain: attempt.originChain,
            destinationChain,
            depositTxHash: attempt.depositTxHash,
            originNonce: attempt.originNonce,
            finalizedNonce,
          },
          'Origin deposit nonce finalized by a replacement transaction; clearing attempt for retry',
        );
        await stateStore.delete(destinationChain, recipient);
        return undefined;
      }

      if (
        attempt.phase === 'prepared' &&
        typeof originProvider.getTransactionCount === 'function'
      ) {
        const pendingNonce = await originProvider.getTransactionCount(
          attempt.funderAddress,
          'pending',
        );
        if (
          typeof pendingNonce === 'number' &&
          pendingNonce <= attempt.originNonce
        ) {
          logger.info(
            {
              originChain: attempt.originChain,
              destinationChain,
              depositTxHash: attempt.depositTxHash,
              originNonce: attempt.originNonce,
            },
            'Prepared bridge attempt was never accepted on origin; clearing for retry',
          );
          await stateStore.delete(destinationChain, recipient);
          return undefined;
        }
      }
    }

    // Submission remains uncertain (unfinalized and missing from node lookup):
    // rebroadcast the exact same signed raw transaction when retained.
    if (
      attempt.signedTransaction &&
      typeof originProvider.sendTransaction === 'function'
    ) {
      try {
        const rebroadcastResp = await originProvider.sendTransaction(
          attempt.signedTransaction,
        );
        attempt = {
          ...attempt,
          phase: 'submitted',
          broadcastStage: 'submitted',
          depositTxHash: rebroadcastResp.hash || attempt.depositTxHash,
          updatedAtMs: Date.now(),
        };
        await stateStore.set(attempt);
      } catch (error) {
        if (!isBenignRebroadcastError(error)) {
          logger.warn(
            {
              error,
              originChain: attempt.originChain,
              depositTxHash: attempt.depositTxHash,
            },
            'Rebroadcast of uncertain origin deposit failed; keeping attempt reserved',
          );
        }
      }
    }

    return attempt;
  }

  if (
    attempt.phase === 'prepared' &&
    attempt.originNonce !== undefined &&
    typeof originProvider.getTransactionCount === 'function'
  ) {
    const pendingNonce = await originProvider.getTransactionCount(
      attempt.funderAddress,
      'pending',
    );
    if (
      typeof pendingNonce === 'number' &&
      pendingNonce <= attempt.originNonce
    ) {
      logger.info(
        {
          originChain: attempt.originChain,
          destinationChain,
          originNonce: attempt.originNonce,
        },
        'Unbroadcast prepared bridge attempt reconciled via assigned nonce; clearing for retry',
      );
      await stateStore.delete(destinationChain, recipient);
      return undefined;
    }
  }

  return attempt;
}

/**
 * Sums the native value and gas fee budgets of any unmined origin deposits
 * recorded for the same (originChain, funderAddress).
 */
export async function getUnresolvedOriginNativeSpend(params: {
  multiProvider: MultiProvider;
  stateStore?: BridgeStateStore;
  originChain: string;
  funderAddress: string;
  excludeDestinationChain?: string;
  excludeRecipient?: string;
}): Promise<BigNumber> {
  const {
    multiProvider,
    stateStore,
    originChain,
    funderAddress,
    excludeDestinationChain,
    excludeRecipient,
  } = params;

  if (!stateStore) {
    return BigNumber.from(0);
  }

  const attempts = await stateStore.listByOriginSigner(
    originChain,
    funderAddress,
  );
  if (attempts.length === 0) {
    return BigNumber.from(0);
  }

  const originProvider = multiProvider.getProvider(originChain);
  let totalUnresolved = BigNumber.from(0);

  for (const entry of attempts) {
    if (
      excludeDestinationChain &&
      excludeRecipient &&
      entry.destinationChain === excludeDestinationChain &&
      eqAddress(entry.recipient, excludeRecipient)
    ) {
      continue;
    }

    if (entry.phase === 'confirmed') {
      continue;
    }

    if (entry.depositTxHash) {
      const receipt = await fetchTransactionReceipt(
        originProvider,
        entry.depositTxHash,
      );
      if (receipt != null) {
        continue;
      }
    }

    totalUnresolved = totalUnresolved
      .add(BigNumber.from(entry.originNativeValue))
      .add(BigNumber.from(entry.originGasBudget));
  }

  return totalUnresolved;
}
