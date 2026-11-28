import crypto from 'crypto';
import { BigNumber, type providers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Logger } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, eqAddress, rootLogger, sleep } from '@hyperlane-xyz/utils';

import {
  ArbitrumOrbitBridgeMode,
  type BridgeConfig,
  BridgeConfigSchema,
  BridgeStack,
  OpStackBridgeMode,
} from '../config/types.js';

import {
  BridgeDeliveryKind,
  type BridgeDeliveryRef,
  checkBridgeDeliveryStatus,
  extractBridgeDeliveryRefFromReceipt,
  fetchBlock,
  fetchTransactionReceipt,
  verifyReceiptMatchesDepositIntent,
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
  /** Snapshot of the bridge configuration used when this attempt was created. */
  bridgeConfig?: BridgeConfig;
  /** Resolved destination Hyperlane Mailbox address when using hyperlaneHook mode. */
  destinationMailboxAddress?: string;
  /** Target contract on the origin chain invoked by the deposit transaction. */
  depositTarget?: string;
  /** Calldata of the prepared origin deposit transaction. */
  depositCalldata?: string;
  /** Origin block height observed when the attempt was prepared. */
  createdAtOriginBlock?: number;
  /** Origin block height in which the deposit receipt was included. */
  confirmedOriginBlock?: number;
  /** True once the confirmed origin deposit block has reached origin finality. */
  originFinalized?: boolean;
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

function cloneBridgeConfig(config: BridgeConfig): BridgeConfig {
  if (config.stack === BridgeStack.OpStack) {
    return {
      ...config,
      ...(config.hookDelivery
        ? { hookDelivery: { ...config.hookDelivery } }
        : {}),
    };
  }
  return {
    ...config,
    ...(config.originGasToken
      ? { originGasToken: { ...config.originGasToken } }
      : {}),
    ...(config.hookDelivery
      ? { hookDelivery: { ...config.hookDelivery } }
      : {}),
  };
}

function cloneAttempt(attempt: PersistedBridgeAttempt): PersistedBridgeAttempt {
  return {
    ...attempt,
    approvalTxHashes: [...attempt.approvalTxHashes],
    ...(attempt.bridgeConfig
      ? { bridgeConfig: cloneBridgeConfig(attempt.bridgeConfig) }
      : {}),
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

function areDeliveryRefsEqual(
  a?: BridgeDeliveryRef,
  b?: BridgeDeliveryRef,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case BridgeDeliveryKind.OpStackDeposit:
      return (
        b.kind === BridgeDeliveryKind.OpStackDeposit &&
        a.l2TxHash.toLowerCase() === b.l2TxHash.toLowerCase()
      );
    case BridgeDeliveryKind.ArbitrumDeposit:
      return (
        b.kind === BridgeDeliveryKind.ArbitrumDeposit &&
        a.childTxHash.toLowerCase() === b.childTxHash.toLowerCase()
      );
    case BridgeDeliveryKind.ArbitrumRetryable:
      return (
        b.kind === BridgeDeliveryKind.ArbitrumRetryable &&
        a.retryableCreationId.toLowerCase() ===
          b.retryableCreationId.toLowerCase()
      );
    case BridgeDeliveryKind.HyperlaneMessage:
      return (
        b.kind === BridgeDeliveryKind.HyperlaneMessage &&
        a.messageId.toLowerCase() === b.messageId.toLowerCase() &&
        (a.destinationMailboxAddress ?? '').toLowerCase() ===
          (b.destinationMailboxAddress ?? '').toLowerCase()
      );
  }
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
    raw.destinationMailboxAddress === undefined ||
      typeof raw.destinationMailboxAddress === 'string',
    `Invalid bridge state record "${recordKey}": invalid destinationMailboxAddress`,
  );
  assert(
    raw.depositTarget === undefined || typeof raw.depositTarget === 'string',
    `Invalid bridge state record "${recordKey}": invalid depositTarget`,
  );
  assert(
    raw.depositCalldata === undefined ||
      typeof raw.depositCalldata === 'string',
    `Invalid bridge state record "${recordKey}": invalid depositCalldata`,
  );
  assert(
    raw.createdAtOriginBlock === undefined ||
      (typeof raw.createdAtOriginBlock === 'number' &&
        Number.isInteger(raw.createdAtOriginBlock) &&
        raw.createdAtOriginBlock >= 0),
    `Invalid bridge state record "${recordKey}": invalid createdAtOriginBlock`,
  );
  assert(
    raw.confirmedOriginBlock === undefined ||
      (typeof raw.confirmedOriginBlock === 'number' &&
        Number.isInteger(raw.confirmedOriginBlock) &&
        raw.confirmedOriginBlock >= 0),
    `Invalid bridge state record "${recordKey}": invalid confirmedOriginBlock`,
  );
  assert(
    raw.originFinalized === undefined ||
      typeof raw.originFinalized === 'boolean',
    `Invalid bridge state record "${recordKey}": invalid originFinalized`,
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

  let parsedBridgeConfig: BridgeConfig | undefined;
  if (raw.bridgeConfig !== undefined) {
    const parsedConfig = BridgeConfigSchema.safeParse(raw.bridgeConfig);
    assert(
      parsedConfig.success,
      `Invalid bridge state record "${recordKey}": invalid bridgeConfig`,
    );
    parsedBridgeConfig = parsedConfig.data;
  }

  const deliveryRef = parseDeliveryRef(recordKey, raw.deliveryRef);

  return {
    originChain: raw.originChain,
    destinationChain: raw.destinationChain,
    recipient: raw.recipient,
    funderAddress: raw.funderAddress,
    stack: raw.stack,
    mode: raw.mode,
    ...(parsedBridgeConfig !== undefined
      ? { bridgeConfig: parsedBridgeConfig }
      : {}),
    ...(raw.destinationMailboxAddress !== undefined
      ? { destinationMailboxAddress: raw.destinationMailboxAddress }
      : {}),
    ...(raw.depositTarget !== undefined
      ? { depositTarget: raw.depositTarget }
      : {}),
    ...(raw.depositCalldata !== undefined
      ? { depositCalldata: raw.depositCalldata }
      : {}),
    ...(raw.createdAtOriginBlock !== undefined
      ? { createdAtOriginBlock: raw.createdAtOriginBlock }
      : {}),
    ...(raw.confirmedOriginBlock !== undefined
      ? { confirmedOriginBlock: raw.confirmedOriginBlock }
      : {}),
    ...(raw.originFinalized !== undefined
      ? { originFinalized: raw.originFinalized }
      : {}),
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
  lockGeneration?: number;
  attempts: Record<string, PersistedBridgeAttempt | undefined>;
}

interface LockOwnershipRecord {
  ownerId: string;
  generation: number;
  hostId: string;
  pid: number;
  createdAtMs: number;
  expiresAtMs: number;
}

interface ReapGuardRecord {
  ownerId: string;
  hostId: string;
  pid: number;
  createdAtMs: number;
  expiresAtMs: number;
}

interface ActiveFileLock {
  ownerId: string;
  generation: number;
  release: () => void;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_LEASE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 2_000;
const REAP_GUARD_LEASE_MS = 2_000;

function computeLocalHostId(): string {
  let bootId = '';
  try {
    if (fs.existsSync('/proc/sys/kernel/random/boot_id')) {
      bootId = fs
        .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
        .trim();
    }
  } catch {
    // Ignore unreadable boot_id on non-Linux hosts
  }
  return bootId ? `${os.hostname()}:${bootId}` : os.hostname();
}

const LOCAL_LOCK_HOST_ID = computeLocalHostId();

export function getLocalLockHostId(): string {
  return LOCAL_LOCK_HOST_ID;
}

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

function getErrnoCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function syncParentDirectory(dir: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function writeCompleteStagingFile(filePath: string, payload: string): void {
  const fd = fs.openSync(filePath, 'w', 0o600);
  let succeeded = false;
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    succeeded = true;
  } finally {
    fs.closeSync(fd);
    if (!succeeded) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

function tryAtomicPublishStagingFile(
  stagePath: string,
  targetPath: string,
  payload: string,
): 'acquired' | 'exists' {
  try {
    fs.linkSync(stagePath, targetPath);
    return 'acquired';
  } catch (error) {
    const code = getErrnoCode(error);
    if (code === 'EEXIST') {
      return 'exists';
    }
    if (code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS') {
      // Fallback for filesystems without hardlink support: clean up target on any write failure.
      let fd: number | undefined;
      try {
        fd = fs.openSync(targetPath, 'wx', 0o600);
        let wrote = false;
        try {
          fs.writeFileSync(fd, payload, 'utf8');
          fs.fsyncSync(fd);
          wrote = true;
        } finally {
          fs.closeSync(fd);
          if (!wrote) {
            try {
              fs.unlinkSync(targetPath);
            } catch {
              // Ignore cleanup failure
            }
          }
        }
        return 'acquired';
      } catch (wxError) {
        if (getErrnoCode(wxError) === 'EEXIST') {
          return 'exists';
        }
        throw wxError;
      }
    }
    throw error;
  }
}

function readLockOwnershipRecord(
  lockPath: string,
): LockOwnershipRecord | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isPlainRecord(parsed) &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId.length > 0 &&
      typeof parsed.hostId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.createdAtMs === 'number' &&
      typeof parsed.expiresAtMs === 'number'
    ) {
      const generation =
        typeof parsed.generation === 'number' &&
        Number.isInteger(parsed.generation) &&
        parsed.generation >= 0
          ? parsed.generation
          : 0;
      return {
        ownerId: parsed.ownerId,
        generation,
        hostId: parsed.hostId,
        pid: parsed.pid,
        createdAtMs: parsed.createdAtMs,
        expiresAtMs: parsed.expiresAtMs,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function inspectLockFile(
  lockPath: string,
  nowMs: number,
  leaseMs: number,
): {
  exists: boolean;
  isStale: boolean;
  ownerKey?: string;
  generation?: number;
} {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isPlainRecord(parsed) &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId.length > 0 &&
      typeof parsed.hostId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.expiresAtMs === 'number'
    ) {
      const expired = nowMs > parsed.expiresAtMs;
      // Only check local PID liveness when the lock belongs to this exact pod/host;
      // cross-pod locks (e.g. PID 1 in a previous CronJob pod) rely strictly on lease expiry.
      const deadLocalOwner =
        parsed.hostId === LOCAL_LOCK_HOST_ID && !isProcessAlive(parsed.pid);
      const generation =
        typeof parsed.generation === 'number' &&
        Number.isInteger(parsed.generation) &&
        parsed.generation >= 0
          ? parsed.generation
          : 0;
      return {
        exists: true,
        isStale: expired || deadLocalOwner,
        ownerKey: parsed.ownerId,
        generation,
      };
    }
    // Unrecognized/corrupt lock content: only treat as stale after a full lease window
    // so an in-progress fallback write is never mistaken for an abandoned lock.
    return {
      exists: true,
      isStale: nowMs - stat.mtimeMs > leaseMs,
      ownerKey: `mtime:${String(stat.mtimeMs)}:${String(stat.size)}`,
    };
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return { exists: false, isStale: false };
    }
    try {
      const stat = fs.statSync(lockPath);
      return {
        exists: true,
        isStale: nowMs - stat.mtimeMs > leaseMs,
        ownerKey: `mtime:${String(stat.mtimeMs)}:${String(stat.size)}`,
      };
    } catch {
      return { exists: false, isStale: false };
    }
  }
}

export interface FileBridgeStateStoreOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  timeoutMs?: number;
  logger?: Pick<Logger, 'warn'>;
  beforeCommitHook?: () => Promise<void> | void;
}

export class FileBridgeStateStore implements BridgeStateStore {
  private writeLock: Promise<void> = Promise.resolve();
  private tempCounter = 0;

  constructor(
    private readonly filePath: string,
    private readonly lockOptions?: FileBridgeStateStoreOptions,
  ) {}

  private get lockFilePath(): string {
    return `${this.filePath}.lock`;
  }

  private get reapGuardPath(): string {
    return `${this.filePath}.lock.reap`;
  }

  private get generationFilePath(): string {
    return `${this.filePath}.lock.gen`;
  }

  private readMaxPersistedGeneration(): number {
    let maxGen = 0;
    try {
      if (fs.existsSync(this.generationFilePath)) {
        const rawGen = fs.readFileSync(this.generationFilePath, 'utf8').trim();
        const parsedGen = Number(rawGen);
        if (Number.isInteger(parsedGen) && parsedGen > maxGen) {
          maxGen = parsedGen;
        }
      }
    } catch {
      // Ignore unreadable generation marker; state/lock files still carry generation
    }

    try {
      if (fs.existsSync(this.filePath)) {
        const parsedState: unknown = JSON.parse(
          fs.readFileSync(this.filePath, 'utf8'),
        );
        if (
          isPlainRecord(parsedState) &&
          typeof parsedState.lockGeneration === 'number' &&
          Number.isInteger(parsedState.lockGeneration) &&
          parsedState.lockGeneration > maxGen
        ) {
          maxGen = parsedState.lockGeneration;
        }
      }
    } catch {
      // Corrupt state file is surfaced by readStateFromDisk
    }

    const currentLock = readLockOwnershipRecord(this.lockFilePath);
    if (currentLock && currentLock.generation > maxGen) {
      maxGen = currentLock.generation;
    }
    return maxGen;
  }

  private writeGenerationMarker(dir: string, generation: number): void {
    this.tempCounter += 1;
    const stageGen = `${this.generationFilePath}.${process.pid}.${this.tempCounter}.stage`;
    writeCompleteStagingFile(stageGen, String(generation));
    fs.renameSync(stageGen, this.generationFilePath);
    syncParentDirectory(dir);
  }

  private tryAcquireReapGuard(dir: string): (() => void) | undefined {
    const now = Date.now();
    const guardOwner = crypto.randomUUID();
    const stagePath = `${this.reapGuardPath}.${guardOwner}.stage`;
    const record: ReapGuardRecord = {
      ownerId: guardOwner,
      hostId: LOCAL_LOCK_HOST_ID,
      pid: process.pid,
      createdAtMs: now,
      expiresAtMs: now + REAP_GUARD_LEASE_MS,
    };
    const payload = JSON.stringify(record);
    writeCompleteStagingFile(stagePath, payload);
    try {
      const res = tryAtomicPublishStagingFile(
        stagePath,
        this.reapGuardPath,
        payload,
      );
      if (res === 'acquired') {
        syncParentDirectory(dir);
        return () => {
          try {
            const current = inspectLockFile(
              this.reapGuardPath,
              Date.now(),
              REAP_GUARD_LEASE_MS,
            );
            if (current.ownerKey === guardOwner) {
              fs.unlinkSync(this.reapGuardPath);
            }
          } catch {
            // Guard already cleaned up
          }
        };
      }

      const guardState = inspectLockFile(
        this.reapGuardPath,
        now,
        REAP_GUARD_LEASE_MS,
      );
      if (guardState.exists && guardState.isStale) {
        try {
          fs.renameSync(stagePath, this.reapGuardPath);
          syncParentDirectory(dir);
          return () => {
            try {
              const current = inspectLockFile(
                this.reapGuardPath,
                Date.now(),
                REAP_GUARD_LEASE_MS,
              );
              if (current.ownerKey === guardOwner) {
                fs.unlinkSync(this.reapGuardPath);
              }
            } catch {
              // Guard already cleaned up
            }
          };
        } catch {
          return undefined;
        }
      }
      return undefined;
    } finally {
      try {
        if (fs.existsSync(stagePath)) {
          fs.unlinkSync(stagePath);
        }
      } catch {
        // Ignore staging cleanup error
      }
    }
  }

  private acquireReapGuardSync(dir: string, timeoutMs = 2_000): () => void {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const guard = this.tryAcquireReapGuard(dir);
      if (guard) {
        return guard;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring commit fence guard for bridge state file ${this.filePath}`,
        );
      }
    }
  }

  private refreshOwnedLockLease(
    dir: string,
    ownerId: string,
    generation: number,
    createdAtMs: number,
    leaseMs: number,
  ): void {
    const releaseGuard = this.tryAcquireReapGuard(dir);
    if (!releaseGuard) {
      return;
    }
    const stagePath = `${this.lockFilePath}.${ownerId}.refresh.stage`;
    try {
      const current = readLockOwnershipRecord(this.lockFilePath);
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.generation !== generation
      ) {
        return;
      }
      const refreshed: LockOwnershipRecord = {
        ownerId,
        generation,
        hostId: LOCAL_LOCK_HOST_ID,
        pid: process.pid,
        createdAtMs,
        expiresAtMs: Date.now() + leaseMs,
      };
      writeCompleteStagingFile(stagePath, JSON.stringify(refreshed));
      fs.renameSync(stagePath, this.lockFilePath);
    } catch (error) {
      // Log renewal failure with path and owner ID while keeping heartbeat best-effort.
      (this.lockOptions?.logger ?? rootLogger).warn(
        { stateFilePath: this.filePath, ownerId, generation, error },
        'Failed to renew bridge state lock lease; will retry on next heartbeat',
      );
    } finally {
      try {
        if (fs.existsSync(stagePath)) {
          fs.unlinkSync(stagePath);
        }
      } catch {
        // Ignore staging cleanup error
      }
      releaseGuard();
    }
  }

  private async acquireInterprocessLock(): Promise<ActiveFileLock> {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const leaseMs = this.lockOptions?.leaseMs ?? LOCK_LEASE_MS;
    const heartbeatMs = this.lockOptions?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
    const timeoutMs = this.lockOptions?.timeoutMs ?? LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    const makeActiveLock = (
      ownerId: string,
      generation: number,
      createdAtMs: number,
    ): ActiveFileLock => {
      const timer = setInterval(() => {
        this.refreshOwnedLockLease(
          dir,
          ownerId,
          generation,
          createdAtMs,
          leaseMs,
        );
      }, heartbeatMs);
      timer.unref();

      return {
        ownerId,
        generation,
        release: () => {
          clearInterval(timer);
          const releaseDeadline = Date.now() + 500;
          for (;;) {
            const releaseGuard = this.tryAcquireReapGuard(dir);
            if (releaseGuard) {
              try {
                const current = readLockOwnershipRecord(this.lockFilePath);
                if (
                  current?.ownerId === ownerId &&
                  current.generation === generation
                ) {
                  fs.unlinkSync(this.lockFilePath);
                  syncParentDirectory(dir);
                }
              } catch {
                // Lock already removed
              } finally {
                releaseGuard();
              }
              return;
            }
            if (Date.now() >= releaseDeadline) {
              return;
            }
          }
        },
      };
    };

    for (;;) {
      const releaseGuard = this.tryAcquireReapGuard(dir);
      if (releaseGuard) {
        const now = Date.now();
        const ownerId = crypto.randomUUID();
        const stagePath = `${this.lockFilePath}.${ownerId}.stage`;
        try {
          const observed = inspectLockFile(this.lockFilePath, now, leaseMs);
          if (!observed.exists || observed.isStale) {
            const nextGeneration = this.readMaxPersistedGeneration() + 1;
            const record: LockOwnershipRecord = {
              ownerId,
              generation: nextGeneration,
              hostId: LOCAL_LOCK_HOST_ID,
              pid: process.pid,
              createdAtMs: now,
              expiresAtMs: now + leaseMs,
            };
            const payload = JSON.stringify(record);
            writeCompleteStagingFile(stagePath, payload);
            this.writeGenerationMarker(dir, nextGeneration);

            if (!observed.exists) {
              const publishResult = tryAtomicPublishStagingFile(
                stagePath,
                this.lockFilePath,
                payload,
              );
              if (publishResult === 'acquired') {
                syncParentDirectory(dir);
                return makeActiveLock(ownerId, nextGeneration, now);
              }
            } else {
              // Atomically replace the verified stale lockfile under reapGuard
              // without an unlink gap so a competing contender never unlinks a live lock.
              fs.renameSync(stagePath, this.lockFilePath);
              syncParentDirectory(dir);
              return makeActiveLock(ownerId, nextGeneration, now);
            }
          }
        } finally {
          try {
            if (fs.existsSync(stagePath)) {
              fs.unlinkSync(stagePath);
            }
          } catch {
            // Ignore staging cleanup error
          }
          releaseGuard();
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring interprocess lock for bridge state file ${this.filePath}`,
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  private async withExclusiveLock<T>(
    operation: (activeLock: ActiveFileLock) => Promise<T>,
  ): Promise<T> {
    const execution = this.writeLock.then(async () => {
      const activeLock = await this.acquireInterprocessLock();
      try {
        return await operation(activeLock);
      } finally {
        activeLock.release();
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
      parsed.lockGeneration === undefined ||
        (typeof parsed.lockGeneration === 'number' &&
          Number.isInteger(parsed.lockGeneration) &&
          parsed.lockGeneration >= 0),
      `Invalid bridge state file at ${this.filePath}: invalid lockGeneration`,
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
      ...(parsed.lockGeneration !== undefined
        ? { lockGeneration: parsed.lockGeneration }
        : {}),
      attempts: validatedAttempts,
    };
  }

  private async commitStateToDisk(
    state: SerializedBridgeStateFile,
    activeLock: ActiveFileLock,
  ): Promise<void> {
    await this.lockOptions?.beforeCommitHook?.();

    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.tempCounter += 1;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.tempCounter}.tmp`;

    const fencedState: SerializedBridgeStateFile = {
      version: 1,
      lockGeneration: activeLock.generation,
      attempts: state.attempts,
    };

    writeCompleteStagingFile(tempPath, JSON.stringify(fencedState, null, 2));
    try {
      // Acquire the same reapGuard mutex required by lock acquisition/reaping so
      // generation & ownership validation and `fs.renameSync` execute atomically
      // with respect to any competing writer claiming a newer generation.
      const releaseGuard = this.acquireReapGuardSync(dir);
      try {
        const now = Date.now();
        const currentOwner = readLockOwnershipRecord(this.lockFilePath);
        assert(
          currentOwner !== undefined &&
            currentOwner.ownerId === activeLock.ownerId &&
            currentOwner.generation === activeLock.generation &&
            now <= currentOwner.expiresAtMs,
          `Bridge state commit fenced out for ${this.filePath}: lock ownership (${activeLock.ownerId} gen ${activeLock.generation}) lost or expired`,
        );

        const maxGeneration = this.readMaxPersistedGeneration();
        assert(
          maxGeneration <= activeLock.generation,
          `Bridge state commit fenced out for ${this.filePath}: writer generation ${activeLock.generation} superseded by generation ${maxGeneration}`,
        );

        fs.renameSync(tempPath, this.filePath);
        syncParentDirectory(dir);
      } finally {
        releaseGuard();
      }
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore temp cleanup error
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
    return this.withExclusiveLock(async (activeLock) => {
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(
        attempt.destinationChain,
        attempt.recipient,
      );
      state.attempts[key] = cloneAttempt(attempt);
      await this.commitStateToDisk(state, activeLock);
    });
  }

  async delete(destinationChain: string, recipient: string): Promise<void> {
    return this.withExclusiveLock(async (activeLock) => {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const state = this.readStateFromDisk();
      const key = makeRecipientScopeKey(destinationChain, recipient);
      if (Object.prototype.hasOwnProperty.call(state.attempts, key)) {
        delete state.attempts[key];
        await this.commitStateToDisk(state, activeLock);
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

async function fetchTransactionResponse(
  provider: providers.Provider,
  txHash: string,
): Promise<providers.TransactionResponse | null | undefined> {
  if (typeof provider.getTransaction !== 'function') {
    return undefined;
  }
  const response: providers.TransactionResponse | null | undefined =
    await provider.getTransaction(txHash);
  return response;
}

async function resolveFinalizedOriginState(
  multiProvider: MultiProvider,
  originChain: string,
  funderAddress: string,
): Promise<{ finalizedNonce?: number; finalizedBlockNumber?: number }> {
  const originProvider = multiProvider.getProvider(originChain);
  if (typeof originProvider.getTransactionCount !== 'function') {
    return {};
  }

  const metadata = multiProvider.getChainMetadata(originChain);
  const reorgPeriod = metadata.blocks?.reorgPeriod;
  const confirmations = metadata.blocks?.confirmations ?? 1;

  if (typeof reorgPeriod === 'string') {
    const count = await originProvider.getTransactionCount(
      funderAddress,
      reorgPeriod,
    );
    let finalizedBlockNumber: number | undefined;
    const tagBlock = await fetchBlock(originProvider, reorgPeriod);
    if (tagBlock != null && typeof tagBlock.number === 'number') {
      finalizedBlockNumber = tagBlock.number;
    }
    return {
      finalizedNonce: typeof count === 'number' ? count : undefined,
      finalizedBlockNumber,
    };
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
      return {
        finalizedNonce: typeof count === 'number' ? count : undefined,
        finalizedBlockNumber: finalizedHeight,
      };
    }
  }

  const count = await originProvider.getTransactionCount(
    funderAddress,
    'finalized',
  );
  return {
    finalizedNonce: typeof count === 'number' ? count : undefined,
  };
}

function getBridgeTargetContract(bridge?: BridgeConfig): string | undefined {
  if (!bridge) {
    return undefined;
  }
  if (bridge.stack === BridgeStack.OpStack) {
    return bridge.mode === OpStackBridgeMode.HyperlaneHook
      ? bridge.hookDelivery?.mailboxAddress
      : bridge.bridgeContract;
  }
  return bridge.mode === ArbitrumOrbitBridgeMode.HyperlaneHook
    ? bridge.hookDelivery?.mailboxAddress
    : bridge.inboxAddress;
}

async function findRepricedReplacementReceipt(params: {
  originProvider: providers.Provider;
  attempt: PersistedBridgeAttempt;
  effectiveBridge?: BridgeConfig;
  destinationChainId?: number;
  finalizedBlockNumber?: number;
}): Promise<
  | {
      receipt: providers.TransactionReceipt;
      deliveryRef?: BridgeDeliveryRef;
    }
  | undefined
> {
  const {
    originProvider,
    attempt,
    effectiveBridge,
    destinationChainId,
    finalizedBlockNumber,
  } = params;
  if (
    attempt.originNonce === undefined ||
    typeof originProvider.getLogs !== 'function' ||
    typeof originProvider.getTransaction !== 'function'
  ) {
    return undefined;
  }

  const targetAddress =
    attempt.depositTarget ?? getBridgeTargetContract(effectiveBridge);
  if (!targetAddress) {
    return undefined;
  }

  const fromBlock =
    attempt.createdAtOriginBlock ??
    (finalizedBlockNumber !== undefined
      ? Math.max(0, finalizedBlockNumber - 2_048)
      : 0);
  const toBlock: providers.BlockTag = finalizedBlockNumber ?? 'latest';

  const logs: providers.Log[] | undefined = await originProvider.getLogs({
    address: targetAddress,
    fromBlock,
    toBlock,
  });
  if (!Array.isArray(logs) || logs.length === 0) {
    return undefined;
  }

  const checkedHashes = new Set<string>();
  for (const log of logs) {
    const txHash = log.transactionHash;
    if (!txHash || checkedHashes.has(txHash.toLowerCase())) {
      continue;
    }
    checkedHashes.add(txHash.toLowerCase());

    const tx = await fetchTransactionResponse(originProvider, txHash);
    if (
      tx == null ||
      !eqAddress(tx.from, attempt.funderAddress) ||
      tx.nonce !== attempt.originNonce
    ) {
      continue;
    }

    const receipt = await fetchTransactionReceipt(originProvider, txHash);
    if (receipt == null) {
      continue;
    }
    if (receipt.status === 0) {
      return { receipt };
    }

    const txValue = BigNumber.from(tx.value);
    const expectedOriginValue = BigNumber.from(attempt.originNativeValue);

    let matchesOriginalIntent = false;
    if (attempt.depositCalldata !== undefined) {
      matchesOriginalIntent =
        tx.to !== undefined &&
        eqAddress(tx.to, targetAddress) &&
        typeof tx.data === 'string' &&
        tx.data.toLowerCase() === attempt.depositCalldata.toLowerCase() &&
        txValue.eq(expectedOriginValue);
    } else {
      matchesOriginalIntent = verifyReceiptMatchesDepositIntent({
        receipt,
        txValue,
        funderAddress: attempt.funderAddress,
        recipient: attempt.recipient,
        expectedBridgedAmount: BigNumber.from(attempt.bridgedAmount),
        expectedOriginNativeValue: expectedOriginValue,
        bridge: effectiveBridge,
      });
    }

    if (!matchesOriginalIntent) {
      continue;
    }

    const deliveryRef = effectiveBridge
      ? extractBridgeDeliveryRefFromReceipt({
          receipt,
          bridge: effectiveBridge,
          destinationChainId,
          destinationMailboxAddress: attempt.destinationMailboxAddress,
        })
      : undefined;

    return { receipt, deliveryRef };
  }

  return undefined;
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

  // Only attempts that stopped strictly before entering `onSubmissionAttempt`
  // (`before_attempt`) are guaranteed never to have hit the network.
  if (
    attempt.phase === 'prepared' &&
    attempt.broadcastStage === 'before_attempt'
  ) {
    await stateStore.delete(destinationChain, recipient);
    return undefined;
  }

  const effectiveBridge = attempt.bridgeConfig ?? bridge;
  const originProvider = multiProvider.getProvider(attempt.originChain);
  const destMeta = multiProvider.getChainMetadata(destinationChain);
  const destChainId =
    typeof destMeta.chainId === 'number' ? destMeta.chainId : undefined;

  const checkDestinationDelivery = async (
    current: PersistedBridgeAttempt,
  ): Promise<PersistedBridgeAttempt | undefined> => {
    if (!current.deliveryRef) {
      return current;
    }
    const status = await checkBridgeDeliveryStatus({
      multiProvider,
      destinationChain,
      bridge: effectiveBridge,
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

  // Only skip origin receipt re-validation once the origin inclusion block is finalized;
  // before finality, an origin reorg can change the OP Stack L2 deposit hash.
  if (
    attempt.phase === 'confirmed' &&
    attempt.originFinalized === true &&
    attempt.deliveryRef
  ) {
    return checkDestinationDelivery(attempt);
  }

  if (attempt.depositTxHash) {
    const currentDepositTxHash = attempt.depositTxHash;
    const receipt = await fetchTransactionReceipt(
      originProvider,
      currentDepositTxHash,
    );

    if (receipt != null) {
      if (receipt.status === 0) {
        logger.warn(
          {
            originChain: attempt.originChain,
            destinationChain,
            depositTxHash: currentDepositTxHash,
          },
          'Origin bridge deposit reverted; clearing persisted attempt for retry',
        );
        await stateStore.delete(destinationChain, recipient);
        return undefined;
      }

      const refreshedRef = effectiveBridge
        ? extractBridgeDeliveryRefFromReceipt({
            receipt,
            bridge: effectiveBridge,
            destinationChainId: destChainId,
            destinationMailboxAddress: attempt.destinationMailboxAddress,
          })
        : undefined;
      const nextDeliveryRef = refreshedRef ?? attempt.deliveryRef;

      let finalizedBlockNumber: number | undefined;
      try {
        const finalizedState = await resolveFinalizedOriginState(
          multiProvider,
          attempt.originChain,
          attempt.funderAddress,
        );
        finalizedBlockNumber = finalizedState.finalizedBlockNumber;
      } catch (error) {
        logger.warn(
          {
            error,
            originChain: attempt.originChain,
            destinationChain,
            depositTxHash: currentDepositTxHash,
          },
          'Failed to resolve finalized origin block height; keeping originFinalized false and continuing delivery check',
        );
      }
      const isOriginFinalized =
        finalizedBlockNumber !== undefined &&
        typeof receipt.blockNumber === 'number' &&
        receipt.blockNumber <= finalizedBlockNumber;

      if (
        attempt.phase !== 'confirmed' ||
        attempt.confirmedOriginBlock !== receipt.blockNumber ||
        attempt.originFinalized !== isOriginFinalized ||
        !areDeliveryRefsEqual(attempt.deliveryRef, nextDeliveryRef)
      ) {
        attempt = {
          ...attempt,
          phase: 'confirmed',
          broadcastStage: 'submitted',
          confirmedOriginBlock: receipt.blockNumber,
          originFinalized: isOriginFinalized,
          ...(nextDeliveryRef ? { deliveryRef: nextDeliveryRef } : {}),
          updatedAtMs: Date.now(),
        };
        await stateStore.set(attempt);
      }

      return checkDestinationDelivery(attempt);
    }

    if (attempt.phase === 'confirmed') {
      // If destination execution has already succeeded (or origin receipt is
      // unavailable on a partial mock returning `undefined` rather than JSON-RPC `null`),
      // check destination delivery before demoting a confirmed attempt.
      if (attempt.deliveryRef) {
        const destAfterMissingReceipt = await checkDestinationDelivery(attempt);
        if (!destAfterMissingReceipt) {
          return undefined;
        }
        if (receipt === undefined) {
          return destAfterMissingReceipt;
        }
      }

      // Origin JSON-RPC explicitly returned `null`: reorg temporarily unmined
      // an unfinalized receipt, so drop the stale locator and continue as submitted.
      const {
        deliveryRef: _droppedRef,
        confirmedOriginBlock: _droppedBlock,
        originFinalized: _droppedFinalized,
        ...restAttempt
      } = attempt;
      attempt = {
        ...restAttempt,
        phase: 'submitted',
        broadcastStage: 'submitted',
        updatedAtMs: Date.now(),
      };
      await stateStore.set(attempt);
    }

    const knownTx = await fetchTransactionResponse(
      originProvider,
      currentDepositTxHash,
    );
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
  }

  if (attempt.originNonce !== undefined) {
    const { finalizedNonce, finalizedBlockNumber } =
      await resolveFinalizedOriginState(
        multiProvider,
        attempt.originChain,
        attempt.funderAddress,
      );

    if (finalizedNonce !== undefined && finalizedNonce > attempt.originNonce) {
      if (attempt.depositTxHash) {
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
          const deliveryRef = effectiveBridge
            ? extractBridgeDeliveryRefFromReceipt({
                receipt: postFinalityReceipt,
                bridge: effectiveBridge,
                destinationChainId: destChainId,
                destinationMailboxAddress: attempt.destinationMailboxAddress,
              })
            : attempt.deliveryRef;
          attempt = {
            ...attempt,
            phase: 'confirmed',
            broadcastStage: 'submitted',
            confirmedOriginBlock: postFinalityReceipt.blockNumber,
            originFinalized: true,
            ...(deliveryRef ? { deliveryRef } : {}),
            updatedAtMs: Date.now(),
          };
          await stateStore.set(attempt);
          return checkDestinationDelivery(attempt);
        }
      }

      // Check whether the nonce was consumed by a repriced/speed-up bridge deposit
      // rather than a cancellation before clearing the attempt.
      const replacement = await findRepricedReplacementReceipt({
        originProvider,
        attempt,
        effectiveBridge,
        destinationChainId: destChainId,
        finalizedBlockNumber,
      });
      if (replacement) {
        if (replacement.receipt.status === 0) {
          await stateStore.delete(destinationChain, recipient);
          return undefined;
        }
        attempt = {
          ...attempt,
          phase: 'confirmed',
          broadcastStage: 'submitted',
          depositTxHash: replacement.receipt.transactionHash,
          confirmedOriginBlock: replacement.receipt.blockNumber,
          originFinalized: true,
          ...(replacement.deliveryRef
            ? { deliveryRef: replacement.deliveryRef }
            : {}),
          updatedAtMs: Date.now(),
        };
        await stateStore.set(attempt);
        logger.info(
          {
            originChain: attempt.originChain,
            destinationChain,
            originNonce: attempt.originNonce,
            replacementTxHash: replacement.receipt.transactionHash,
          },
          'Adopted repriced origin bridge deposit transaction for finalized nonce',
        );
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
        'Origin deposit nonce finalized by a cancellation transaction; clearing attempt for retry',
      );
      await stateStore.delete(destinationChain, recipient);
      return undefined;
    }
  }

  // Submission remains uncertain (unfinalized and missing from node lookup):
  // keep `attempting` and `submitted` attempts reserved (never clear on pendingNonce alone)
  // and rebroadcast the exact same signed raw transaction when available.
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

/**
 * Sums the native value and gas fee budgets of any origin deposits recorded for
 * the same (originChain, funderAddress) whose debits are not yet included in
 * `snapshotBlockNumber`.
 */
export async function getUnresolvedOriginNativeSpend(params: {
  multiProvider: MultiProvider;
  stateStore?: BridgeStateStore;
  originChain: string;
  funderAddress: string;
  snapshotBlockNumber?: number;
  snapshotBlockHash?: string;
  excludeDestinationChain?: string;
  excludeRecipient?: string;
}): Promise<BigNumber> {
  const {
    multiProvider,
    stateStore,
    originChain,
    funderAddress,
    snapshotBlockNumber,
    snapshotBlockHash,
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

    // Only trust cached `confirmedOriginBlock` without re-verifying the receipt
    // when origin inclusion has reached finality (`originFinalized === true`).
    if (
      entry.phase === 'confirmed' &&
      entry.originFinalized === true &&
      entry.confirmedOriginBlock !== undefined &&
      (snapshotBlockNumber === undefined ||
        entry.confirmedOriginBlock <= snapshotBlockNumber)
    ) {
      continue;
    }

    if (entry.depositTxHash) {
      const receipt = await fetchTransactionReceipt(
        originProvider,
        entry.depositTxHash,
      );
      if (
        receipt != null &&
        (snapshotBlockNumber === undefined ||
          receipt.blockNumber <= snapshotBlockNumber)
      ) {
        let onCanonicalFork = true;
        if (
          snapshotBlockNumber !== undefined &&
          receipt.blockNumber === snapshotBlockNumber &&
          snapshotBlockHash &&
          receipt.blockHash &&
          receipt.blockHash.toLowerCase() !== snapshotBlockHash.toLowerCase()
        ) {
          onCanonicalFork = false;
        } else if (
          snapshotBlockNumber !== undefined &&
          receipt.blockNumber < snapshotBlockNumber
        ) {
          const canonicalBlock = await fetchBlock(
            originProvider,
            receipt.blockNumber,
          );
          if (
            canonicalBlock?.hash &&
            receipt.blockHash &&
            canonicalBlock.hash.toLowerCase() !==
              receipt.blockHash.toLowerCase()
          ) {
            onCanonicalFork = false;
          }
        }

        if (onCanonicalFork) {
          continue;
        }
      }
    }

    totalUnresolved = totalUnresolved
      .add(BigNumber.from(entry.originNativeValue))
      .add(BigNumber.from(entry.originGasBudget));
  }

  return totalUnresolved;
}
