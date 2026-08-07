import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import type {
  MaterializedCurve,
  MaterializedStandingCurve,
  PiecewiseLaneSlot,
} from './piecewise-fee-lib.js';

export const STAGING_LIFECYCLE_LANE_ID = 'bsc-usdt-arbitrum-usdc';
export const STAGING_TRANSFER_AMOUNT = 10n * 10n ** 18n;
export const STAGING_TOKEN_ALLOWANCE_CAP = 50n * 10n ** 18n;

const BPS_X1E4_DENOMINATOR = 100_000_000n;

export type LifecyclePhase = 'fallback' | 'fresh' | 'stale' | 'expired';

export interface StandingTiming {
  issuedAt: number;
  staleAfterSeconds: number;
  expiry: number;
}

export interface LifecycleQuote {
  piecewiseFee: bigint;
  feeRootBalance: bigint;
  tokenDebit: bigint;
  nativeValue: bigint;
  raw: unknown;
}

export interface LifecycleTransferResult {
  txHash: string;
  feeRootBalance: bigint;
  blockTimestamp: number;
}

export interface LifecycleDependencies {
  getBlockTimestamp(): Promise<number>;
  getStandingTiming(): Promise<StandingTiming>;
  verifyFallback(): Promise<void>;
  quote(): Promise<LifecycleQuote>;
  waitUntilBlockTimestamp(target: number): Promise<number>;
  beginTransfers?(): Promise<void>;
  publishStanding?(): Promise<StandingTiming>;
  transfer?(
    phase: LifecyclePhase,
    quote: LifecycleQuote,
  ): Promise<LifecycleTransferResult>;
  endTransfers?(): Promise<void>;
}

export interface LifecycleOptions {
  submit: boolean;
  slot: PiecewiseLaneSlot;
  fallbackCurve: MaterializedCurve;
  standingCurve: MaterializedStandingCurve;
  dependencies: LifecycleDependencies;
  log(line: string): void;
}

export interface LifecyclePhaseResult {
  phase: LifecyclePhase;
  expectedFee: bigint;
  txHash: string;
  blockTimestamp: number;
}

export function assertStagingLifecycleLane(slot: PiecewiseLaneSlot): void {
  assert(
    slot.laneId === STAGING_LIFECYCLE_LANE_ID &&
      slot.origin === 'bsc' &&
      slot.destination === 'arbitrum' &&
      slot.sourceRouteId === 'USDT/moonpay-staging' &&
      slot.targetRouteId === 'USDC/moonpay-staging',
    `Lifecycle is locked to ${STAGING_LIFECYCLE_LANE_ID} (BSC USDT -> Arbitrum USDC)`,
  );
  assert(
    slot.tokenDecimals === 18,
    `Lifecycle amount is fixed at 10e18; fee token must have 18 decimals, got ${slot.tokenDecimals}`,
  );
}

export function assertExactRouterConfirmations(
  slot: PiecewiseLaneSlot,
  confirmedSourceRouter: string | undefined,
  confirmedTargetRouter: string | undefined,
): void {
  assert(
    confirmedSourceRouter !== undefined &&
      ethers.utils.isAddress(confirmedSourceRouter) &&
      confirmedSourceRouter.toLowerCase() === slot.sourceRouter.toLowerCase(),
    `--confirm-source-router must exactly match discovered BSC router ${slot.sourceRouter}`,
  );
  assert(
    confirmedTargetRouter !== undefined &&
      ethers.utils.isAddress(confirmedTargetRouter) &&
      confirmedTargetRouter.toLowerCase() === slot.targetRouter.toLowerCase(),
    `--confirm-target-router must exactly match discovered Arbitrum router ${slot.targetRouter}`,
  );
}

export function computePiecewiseFee(
  curve: MaterializedCurve,
  amount: bigint,
): bigint {
  assert(amount >= 0n, 'amount must be non-negative');
  let weighted = 0n;
  let start = 0n;
  for (let band = 0; band < curve.marginalBpsX1e4.length; band += 1) {
    const end = curve.breakpoints[band] ?? amount;
    const amountInBand = amount < end ? amount - start : end - start;
    if (amountInBand > 0n) {
      weighted += amountInBand * BigInt(curve.marginalBpsX1e4[band]);
    }
    if (amount <= end) break;
    start = end;
  }
  return weighted / BPS_X1E4_DENOMINATOR;
}

export function staleCurve(
  curve: MaterializedStandingCurve,
): MaterializedCurve {
  return {
    breakpoints: curve.breakpoints,
    marginalBpsX1e4: curve.marginalBpsX1e4.map(
      (rate, index) => rate + curve.staleMarginalSurchargeBpsX1e4[index],
    ),
  };
}

export async function pollForBlockTimestamp(options: {
  target: number;
  readTimestamp(): Promise<number>;
  sleep(ms: number): Promise<void>;
  intervalMs?: number;
  maxPolls?: number;
}): Promise<number> {
  const intervalMs = options.intervalMs ?? 2_000;
  const maxPolls = options.maxPolls ?? 180;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const timestamp = await options.readTimestamp();
    if (timestamp >= options.target) return timestamp;
    await options.sleep(intervalMs);
  }
  throw new Error(
    `BSC block timestamp did not reach ${options.target} within ${maxPolls} polls`,
  );
}

function formatBpsX1e4(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

function expectedCurveForPhase(
  phase: LifecyclePhase,
  fallbackCurve: MaterializedCurve,
  standingCurve: MaterializedStandingCurve,
): MaterializedCurve {
  if (phase === 'fresh') return standingCurve;
  if (phase === 'stale') return staleCurve(standingCurve);
  return fallbackCurve;
}

function assertPhaseTimestamp(
  phase: LifecyclePhase,
  timestamp: number,
  timing: StandingTiming,
): void {
  const staleAt = timing.issuedAt + timing.staleAfterSeconds;
  if (phase === 'fresh') {
    assert(
      timestamp < staleAt && timestamp <= timing.expiry,
      `Fresh transfer mined outside fresh window at ${timestamp}`,
    );
  } else if (phase === 'stale') {
    assert(
      timestamp >= staleAt && timestamp <= timing.expiry,
      `Stale transfer mined outside stale window at ${timestamp}`,
    );
  } else {
    assert(
      timestamp > timing.expiry,
      `${phase} transfer must mine after standing expiry ${timing.expiry}`,
    );
  }
}

async function executePhase(
  phase: LifecyclePhase,
  timing: StandingTiming,
  options: LifecycleOptions,
): Promise<LifecyclePhaseResult> {
  const transfer = options.dependencies.transfer;
  assert(transfer, 'transfer dependency is required with --submit');
  const curve = expectedCurveForPhase(
    phase,
    options.fallbackCurve,
    options.standingCurve,
  );
  const expectedFee = computePiecewiseFee(curve, STAGING_TRANSFER_AMOUNT);
  const expectedEffectiveBpsX1e4 =
    (expectedFee * BPS_X1E4_DENOMINATOR) / STAGING_TRANSFER_AMOUNT;
  const quote = await options.dependencies.quote();
  assert(
    quote.piecewiseFee === expectedFee,
    `${phase} quote fee ${quote.piecewiseFee} != expected ${expectedFee}`,
  );
  assert(
    quote.tokenDebit <= STAGING_TOKEN_ALLOWANCE_CAP,
    `${phase} token debit exceeds the 50e18 lifecycle allowance cap`,
  );
  options.log(
    `${phase}: effective=${formatBpsX1e4(expectedEffectiveBpsX1e4)} bps fee=${expectedFee} rootBefore=${quote.feeRootBalance}`,
  );

  const result = await transfer(phase, quote);
  assertPhaseTimestamp(phase, result.blockTimestamp, timing);
  assert(
    result.feeRootBalance - quote.feeRootBalance === expectedFee,
    `${phase} fee-root balance delta ${result.feeRootBalance - quote.feeRootBalance} != expected ${expectedFee}`,
  );
  options.log(
    `${phase}: ${result.txHash} minedAt=${result.blockTimestamp} rootAfter=${result.feeRootBalance}`,
  );
  return {
    phase,
    expectedFee,
    txHash: result.txHash,
    blockTimestamp: result.blockTimestamp,
  };
}

export async function runStagingLifecycle(
  options: LifecycleOptions,
): Promise<LifecyclePhaseResult[]> {
  assertStagingLifecycleLane(options.slot);
  await options.dependencies.verifyFallback();
  const [timestamp, currentTiming, currentQuote] = await Promise.all([
    options.dependencies.getBlockTimestamp(),
    options.dependencies.getStandingTiming(),
    options.dependencies.quote(),
  ]);
  options.log(
    `${options.submit ? 'SUBMIT' : 'DRY RUN'}: ${STAGING_LIFECYCLE_LANE_ID} amount=${STAGING_TRANSFER_AMOUNT}`,
  );
  options.log(
    `source=${options.slot.sourceRouter} target=${options.slot.targetRouter} feeRoot=${options.slot.routingFeeAddress} feeLeaf=${options.slot.piecewiseFeeAddress}`,
  );
  options.log(
    `current BSC timestamp=${timestamp} storedExpiry=${currentTiming.expiry} currentQuotedFee=${currentQuote.piecewiseFee} rootBalance=${currentQuote.feeRootBalance}`,
  );
  options.log(
    'phases=fallback -> publish standing -> fresh -> stale -> expired',
  );
  if (!options.submit) {
    options.log(
      'Read-only dry run complete. No approval, curve publication, waiting, or transfer occurred.',
    );
    return [];
  }

  const { beginTransfers, publishStanding, endTransfers } =
    options.dependencies;
  assert(beginTransfers, 'beginTransfers dependency is required with --submit');
  assert(
    publishStanding,
    'publishStanding dependency is required with --submit',
  );
  assert(endTransfers, 'endTransfers dependency is required with --submit');

  const results: LifecyclePhaseResult[] = [];
  if (currentTiming.expiry >= timestamp) {
    await options.dependencies.waitUntilBlockTimestamp(
      currentTiming.expiry + 1,
    );
  }
  await beginTransfers();
  try {
    results.push(await executePhase('fallback', currentTiming, options));

    const standingTiming = await publishStanding();
    assert(
      standingTiming.staleAfterSeconds ===
        options.standingCurve.staleAfterSeconds &&
        standingTiming.expiry ===
          standingTiming.issuedAt + options.standingCurve.ttlSeconds,
      'Published standing timing does not match configured staleAfter/ttl',
    );
    results.push(await executePhase('fresh', standingTiming, options));

    await options.dependencies.waitUntilBlockTimestamp(
      standingTiming.issuedAt + standingTiming.staleAfterSeconds,
    );
    results.push(await executePhase('stale', standingTiming, options));

    await options.dependencies.waitUntilBlockTimestamp(
      standingTiming.expiry + 1,
    );
    results.push(await executePhase('expired', standingTiming, options));
    return results;
  } finally {
    await endTransfers();
  }
}
