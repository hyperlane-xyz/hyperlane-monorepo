import { BigNumber } from 'ethers';
import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { BridgeConfig } from '../config/types.js';

export type BridgeAttemptPhase = 'prepared' | 'submitted' | 'confirmed';

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
  /** Origin signer nonce observed prior to deposit broadcast, when available. */
  originNonce?: number;
  /** Origin deposit transaction hash (precomputed signed hash or broadcast hash). */
  depositTxHash?: string;
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
}

function makeRecipientScopeKey(
  destinationChain: string,
  recipient: string,
): string {
  return `${destinationChain}:${recipient.toLowerCase()}`;
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
    return entry
      ? { ...entry, approvalTxHashes: [...entry.approvalTxHashes] }
      : undefined;
  }

  async set(attempt: PersistedBridgeAttempt): Promise<void> {
    this.attempts.set(
      makeRecipientScopeKey(attempt.destinationChain, attempt.recipient),
      {
        ...attempt,
        approvalTxHashes: [...attempt.approvalTxHashes],
      },
    );
  }

  async delete(destinationChain: string, recipient: string): Promise<void> {
    this.attempts.delete(makeRecipientScopeKey(destinationChain, recipient));
  }
}

interface SerializedBridgeStateFile {
  version: 1;
  attempts: Record<string, PersistedBridgeAttempt | undefined>;
}

export class FileBridgeStateStore implements BridgeStateStore {
  private writeLock: Promise<void> = Promise.resolve();
  private tempCounter = 0;

  constructor(private readonly filePath: string) {}

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.writeLock.then(operation);
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('attempts' in parsed) ||
      typeof parsed.attempts !== 'object' ||
      parsed.attempts === null
    ) {
      throw new Error(`Invalid bridge state file format at ${this.filePath}`);
    }
    return {
      version: 1,
      attempts: {
        ...(parsed as SerializedBridgeStateFile).attempts,
      },
    };
  }

  private writeStateToDisk(state: SerializedBridgeStateFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.tempCounter += 1;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  async get(
    destinationChain: string,
    recipient: string,
  ): Promise<PersistedBridgeAttempt | undefined> {
    return this.withLock(async () => {
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(destinationChain, recipient);
      const entry = state.attempts[key];
      return entry
        ? { ...entry, approvalTxHashes: [...entry.approvalTxHashes] }
        : undefined;
    });
  }

  async set(attempt: PersistedBridgeAttempt): Promise<void> {
    return this.withLock(async () => {
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(
        attempt.destinationChain,
        attempt.recipient,
      );
      state.attempts[key] = {
        ...attempt,
        approvalTxHashes: [...attempt.approvalTxHashes],
      };
      this.writeStateToDisk(state);
    });
  }

  async delete(destinationChain: string, recipient: string): Promise<void> {
    return this.withLock(async () => {
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

/**
 * Reconciles a persisted bridge attempt against destination balance settlement
 * and origin transaction status before permitting any retry.
 */
export async function reconcilePendingBridgeAttempt(params: {
  multiProvider: MultiProvider;
  stateStore: BridgeStateStore;
  destinationChain: string;
  recipient: string;
  currentDestinationBalance: BigNumber;
  logger: Logger;
}): Promise<PersistedBridgeAttempt | undefined> {
  const {
    multiProvider,
    stateStore,
    destinationChain,
    recipient,
    currentDestinationBalance,
    logger,
  } = params;

  const attempt = await stateStore.get(destinationChain, recipient);
  if (!attempt) {
    return undefined;
  }

  const baseline = BigNumber.from(attempt.baselineDestinationBalance);
  const expectedCredit = BigNumber.from(attempt.bridgedAmount);
  const minExpectedCredit = expectedCredit.gt(10)
    ? expectedCredit.mul(9).div(10)
    : expectedCredit;

  if (
    expectedCredit.gt(0) &&
    currentDestinationBalance.gte(baseline.add(minExpectedCredit))
  ) {
    await stateStore.delete(destinationChain, recipient);
    logger.info(
      {
        originChain: attempt.originChain,
        destinationChain,
        depositTxHash: attempt.depositTxHash,
      },
      'Pending bridge deposit settled on destination chain',
    );
    return undefined;
  }

  const originProvider = multiProvider.getProvider(attempt.originChain);

  if (attempt.depositTxHash) {
    const receipt =
      typeof originProvider.getTransactionReceipt === 'function'
        ? await originProvider.getTransactionReceipt(attempt.depositTxHash)
        : undefined;

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

      if (attempt.phase !== 'confirmed') {
        const confirmedAttempt: PersistedBridgeAttempt = {
          ...attempt,
          phase: 'confirmed',
          updatedAtMs: Date.now(),
        };
        await stateStore.set(confirmedAttempt);
        return confirmedAttempt;
      }
      return attempt;
    }

    const knownTx =
      typeof originProvider.getTransaction === 'function'
        ? await originProvider.getTransaction(attempt.depositTxHash)
        : undefined;
    if (knownTx != null) {
      if (attempt.phase === 'prepared') {
        const submittedAttempt: PersistedBridgeAttempt = {
          ...attempt,
          phase: 'submitted',
          updatedAtMs: Date.now(),
        };
        await stateStore.set(submittedAttempt);
        return submittedAttempt;
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
            depositTxHash: attempt.depositTxHash,
          },
          'Prepared bridge attempt was never broadcast on origin; clearing for retry',
        );
        await stateStore.delete(destinationChain, recipient);
        return undefined;
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
        'Unbroadcast prepared bridge attempt reconciled via origin nonce; clearing for retry',
      );
      await stateStore.delete(destinationChain, recipient);
      return undefined;
    }
  }

  return attempt;
}
