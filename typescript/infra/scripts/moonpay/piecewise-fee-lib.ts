import { Wallet, constants, ethers } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  IERC20Metadata__factory,
  OffchainQuotedPiecewiseLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { MultiProvider, OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  EIP712_NAME,
  EIP712_VERSION,
  SIGNED_QUOTE_TYPES,
  WILDCARD_RECIPIENT,
} from './oqlf-lib.js';

const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_UINT48 = 2 ** 48 - 1;
const MAX_MARGINAL_BPS_X1E4 = 100_000_000;

export type PublisherMode = 'standing' | 'fallback';

export interface HumanCurve {
  breakpoints: string[];
  marginalBps: number[];
}

export interface HumanStandingCurve extends HumanCurve {
  ttlSeconds: number;
  staleAfterSeconds: number;
  staleMarginalSurchargeBps: number[];
}

export interface PiecewiseLaneConfig {
  id: string;
  origin: string;
  sourceRouteId: string;
  destination: string;
  targetRouteId: string;
  standing?: HumanStandingCurve;
  fallback: HumanCurve;
}

export interface PiecewisePublisherConfig {
  version: 2;
  lanes: PiecewiseLaneConfig[];
}

export interface MaterializedCurve {
  breakpoints: bigint[];
  marginalBpsX1e4: number[];
}

export interface MaterializedStandingCurve extends MaterializedCurve {
  ttlSeconds: number;
  staleAfterSeconds: number;
  staleMarginalSurchargeBpsX1e4: number[];
}

export interface WarpRouteLike {
  tokens: Array<{
    chainName?: string;
    addressOrDenom?: string;
    symbol?: string;
  }>;
}

export interface LaneRegistry {
  getWarpRoute(
    routeId: string,
  ): WarpRouteLike | undefined | Promise<WarpRouteLike | undefined>;
}

export interface LaneOnchainReader {
  getDomainId(chain: string): number;
  getFeeRecipient(origin: string, sourceRouter: string): Promise<string>;
  getFeeType(origin: string, feeAddress: string): Promise<number>;
  getExplicitFeeContract(
    origin: string,
    routingFeeAddress: string,
    destination: number,
    targetRouter: string,
  ): Promise<string>;
  getPiecewiseMetadata(
    origin: string,
    feeAddress: string,
  ): Promise<{ feeToken: string; maxBands: number; tokenDecimals: number }>;
}

export interface PiecewiseLaneSlot {
  laneId: string;
  origin: string;
  sourceRouteId: string;
  sourceRouter: string;
  sourceToken: string;
  destination: string;
  destDomain: number;
  targetRouteId: string;
  targetRouter: string;
  routingFeeAddress: string;
  piecewiseFeeAddress: string;
  feeToken: string;
  tokenDecimals: number;
  maxBands: number;
}

export type PreparedLaneUpdate =
  | {
      mode: 'standing';
      laneIds: string[];
      slot: PiecewiseLaneSlot;
      curve: MaterializedStandingCurve;
    }
  | {
      mode: 'fallback';
      laneIds: string[];
      slot: PiecewiseLaneSlot;
      curve: MaterializedCurve;
    };

export type SubmissionResult =
  | { status: 'unchanged' }
  | { status: 'submitted'; txHash: string };

export const SIGNED_FALLBACK_CURVE_TYPES = {
  SignedFallbackCurve: [
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'submitter', type: 'address' },
  ],
};

function parseDurationSeconds(value: unknown, field: string): number {
  assert(typeof value === 'string', `${field} must be a duration string`);
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)(s|h|d)$/);
  assert(match, `Invalid ${field} ${value}; use a duration such as 12s`);
  const amount = Number(match[1]);
  const multiplier = match[2] === 's' ? 1 : match[2] === 'h' ? 3_600 : 86_400;
  const seconds = amount * multiplier;
  assert(
    Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 0xffff_ffff,
    `${field} must resolve to positive uint32 seconds, got ${value}`,
  );
  return seconds;
}

function parseHumanCurve(value: unknown, field: string): HumanCurve {
  assert(typeof value === 'object' && value !== null, `${field} is required`);
  const curve = value as Record<string, unknown>;
  assert(
    Array.isArray(curve.breakpoints) &&
      curve.breakpoints.every((amount) => typeof amount === 'string'),
    `${field}.breakpoints must be decimal strings`,
  );
  assert(
    Array.isArray(curve.marginalBps) &&
      curve.marginalBps.every((rate) => typeof rate === 'number'),
    `${field}.marginalBps must be numbers`,
  );
  assert(
    curve.marginalBps.length === curve.breakpoints.length + 1,
    `${field}.marginalBps must have one more entry than breakpoints`,
  );
  return {
    breakpoints: [...curve.breakpoints],
    marginalBps: [...curve.marginalBps],
  };
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const value = object[key];
  assert(typeof value === 'string' && value.length > 0, `${field} is required`);
  return value;
}

export function parsePiecewisePublisherConfig(
  input: unknown,
): PiecewisePublisherConfig {
  assert(
    typeof input === 'object' && input !== null,
    'config must be an object',
  );
  const config = input as Record<string, unknown>;
  assert(config.version === 2, 'config version must be 2');
  assert(
    Array.isArray(config.lanes) && config.lanes.length > 0,
    'lanes must be a non-empty array',
  );

  const ids = new Set<string>();
  const lanes = config.lanes.map((rawLane, index): PiecewiseLaneConfig => {
    assert(
      typeof rawLane === 'object' && rawLane !== null,
      `lanes[${index}] must be an object`,
    );
    const lane = rawLane as Record<string, unknown>;
    const id = requiredString(lane, 'id', `lanes[${index}].id`);
    assert(!ids.has(id), `Duplicate lane id ${id}`);
    ids.add(id);
    const fallback = parseHumanCurve(lane.fallback, `lane ${id}.fallback`);

    let standing: HumanStandingCurve | undefined;
    if (lane.standing !== undefined) {
      const parsed = parseHumanCurve(lane.standing, `lane ${id}.standing`);
      const rawStanding = lane.standing as Record<string, unknown>;
      assert(
        Array.isArray(rawStanding.staleMarginalSurchargeBps) &&
          rawStanding.staleMarginalSurchargeBps.every(
            (rate) => typeof rate === 'number',
          ),
        `lane ${id}.standing.staleMarginalSurchargeBps must be numbers`,
      );
      assert(
        rawStanding.staleMarginalSurchargeBps.length ===
          parsed.marginalBps.length,
        `lane ${id}.standing stale surcharges must align with marginalBps`,
      );
      const ttlSeconds = parseDurationSeconds(
        rawStanding.ttl,
        `lane ${id}.standing.ttl`,
      );
      const staleAfterSeconds = parseDurationSeconds(
        rawStanding.staleAfter,
        `lane ${id}.standing.staleAfter`,
      );
      assert(
        staleAfterSeconds <= ttlSeconds,
        `lane ${id}.standing staleAfter must not exceed ttl`,
      );
      standing = {
        ...parsed,
        ttlSeconds,
        staleAfterSeconds,
        staleMarginalSurchargeBps: [...rawStanding.staleMarginalSurchargeBps],
      };
    }

    return {
      id,
      origin: requiredString(lane, 'origin', `lane ${id}.origin`),
      sourceRouteId: requiredString(
        lane,
        'sourceRouteId',
        `lane ${id}.sourceRouteId`,
      ),
      destination: requiredString(
        lane,
        'destination',
        `lane ${id}.destination`,
      ),
      targetRouteId: requiredString(
        lane,
        'targetRouteId',
        `lane ${id}.targetRouteId`,
      ),
      standing,
      fallback,
    };
  });

  return { version: 2, lanes };
}

export function selectPublisherLanes(
  config: PiecewisePublisherConfig,
  selectedIds: readonly string[] | undefined,
  mode: PublisherMode,
): PiecewiseLaneConfig[] {
  const byId = new Map(config.lanes.map((lane) => [lane.id, lane]));
  const ids = selectedIds?.length
    ? [...new Set(selectedIds)]
    : config.lanes.map((lane) => lane.id);
  assert(ids.length > 0, `No lanes selected for ${mode}`);
  return ids.map((id) => {
    const lane = byId.get(id);
    assert(lane, `Selected lane ${id} is absent from config`);
    assert(
      mode !== 'standing' || lane.standing,
      `Selected lane ${id} has no standing curve`,
    );
    return lane;
  });
}

function marginalBpsToX1e4(bps: number): number {
  assert(
    Number.isFinite(bps) && bps >= 0 && bps <= 10_000,
    `marginal bps must be between 0 and 10000, got ${bps}`,
  );
  const scaled = Math.round(bps * 10_000);
  assert(
    Math.abs(scaled / 10_000 - bps) < Number.EPSILON * 10,
    `marginal bps supports at most four decimal places, got ${bps}`,
  );
  return scaled;
}

export function materializeCurve(
  curve: HumanCurve,
  tokenDecimals: number,
  maxBands: number,
): MaterializedCurve {
  assert(
    curve.marginalBps.length <= maxBands,
    `curve has ${curve.marginalBps.length} bands but contract supports ${maxBands}`,
  );
  const breakpoints = curve.breakpoints.map((amount) => {
    const scaled = ethers.utils.parseUnits(amount, tokenDecimals).toBigInt();
    assert(scaled > 0n, `breakpoint must be positive, got ${amount}`);
    assert(scaled <= MAX_UINT128, `breakpoint exceeds uint128: ${amount}`);
    return scaled;
  });
  for (let i = 1; i < breakpoints.length; i += 1) {
    assert(
      breakpoints[i] > breakpoints[i - 1],
      'breakpoints must be strictly increasing',
    );
  }
  const marginalBpsX1e4 = curve.marginalBps.map(marginalBpsToX1e4);
  for (let i = 1; i < marginalBpsX1e4.length; i += 1) {
    assert(
      marginalBpsX1e4[i] >= marginalBpsX1e4[i - 1],
      'marginal rates must be nondecreasing',
    );
  }
  return { breakpoints, marginalBpsX1e4 };
}

export function materializeStandingCurve(
  curve: HumanStandingCurve,
  tokenDecimals: number,
  maxBands: number,
): MaterializedStandingCurve {
  const materialized = materializeCurve(curve, tokenDecimals, maxBands);
  const staleMarginalSurchargeBpsX1e4 =
    curve.staleMarginalSurchargeBps.map(marginalBpsToX1e4);
  for (let i = 0; i < staleMarginalSurchargeBpsX1e4.length; i += 1) {
    if (i > 0) {
      assert(
        staleMarginalSurchargeBpsX1e4[i] >=
          staleMarginalSurchargeBpsX1e4[i - 1],
        'stale surcharges must be nondecreasing',
      );
    }
    assert(
      materialized.marginalBpsX1e4[i] + staleMarginalSurchargeBpsX1e4[i] <=
        MAX_MARGINAL_BPS_X1E4,
      `effective stale marginal bps is too large in band ${i}`,
    );
  }
  return {
    ...materialized,
    ttlSeconds: curve.ttlSeconds,
    staleAfterSeconds: curve.staleAfterSeconds,
    staleMarginalSurchargeBpsX1e4,
  };
}

export function materializeFallbackCurve(
  curve: HumanCurve,
  tokenDecimals: number,
  maxBands: number,
): MaterializedCurve {
  const materialized = materializeCurve(curve, tokenDecimals, maxBands);
  assert(
    materialized.marginalBpsX1e4.some((rate) => rate > 0),
    'fallback curve must charge a nonzero rate',
  );
  return materialized;
}

function requireRouteRouter(
  route: WarpRouteLike,
  chain: string,
  role: 'source' | 'target',
  lane: PiecewiseLaneConfig,
): { address: string; symbol: string } {
  const matches = route.tokens.filter((token) => token.chainName === chain);
  assert(
    matches.length === 1,
    `Lane ${lane.id} ${role} route must contain exactly one token on ${chain}`,
  );
  const token = matches[0];
  assert(token.addressOrDenom, `Lane ${lane.id} ${role} router is missing`);
  if (role === 'source') {
    assert(
      /^0x[0-9a-f]{40}$/i.test(token.addressOrDenom),
      `Lane ${lane.id} source router on ${chain} is not EVM`,
    );
  } else {
    try {
      addressToBytes32(token.addressOrDenom);
    } catch {
      throw new Error(
        `Lane ${lane.id} target router on ${chain} cannot be encoded as bytes32`,
      );
    }
  }
  return { address: token.addressOrDenom, symbol: token.symbol ?? role };
}

export async function discoverPiecewiseLane(
  registry: LaneRegistry,
  reader: LaneOnchainReader,
  lane: PiecewiseLaneConfig,
): Promise<PiecewiseLaneSlot> {
  const [sourceRoute, targetRoute] = await Promise.all([
    registry.getWarpRoute(lane.sourceRouteId),
    registry.getWarpRoute(lane.targetRouteId),
  ]);
  assert(
    sourceRoute,
    `Source route ${lane.sourceRouteId} not found for ${lane.id}`,
  );
  assert(
    targetRoute,
    `Target route ${lane.targetRouteId} not found for ${lane.id}`,
  );
  const source = requireRouteRouter(sourceRoute, lane.origin, 'source', lane);
  const target = requireRouteRouter(
    targetRoute,
    lane.destination,
    'target',
    lane,
  );
  const destDomain = reader.getDomainId(lane.destination);
  const routingFeeAddress = await reader.getFeeRecipient(
    lane.origin,
    source.address,
  );
  assert(
    routingFeeAddress !== constants.AddressZero,
    `Lane ${lane.id} source router has no routing fee`,
  );
  assert(
    (await reader.getFeeType(lane.origin, routingFeeAddress)) ===
      OnchainTokenFeeType.CrossCollateralRoutingFee,
    `Lane ${lane.id} fee root is not CrossCollateralRoutingFee`,
  );
  const piecewiseFeeAddress = await reader.getExplicitFeeContract(
    lane.origin,
    routingFeeAddress,
    destDomain,
    target.address,
  );
  assert(
    piecewiseFeeAddress !== constants.AddressZero,
    `Lane ${lane.id} explicit target has no fee leaf`,
  );
  assert(
    (await reader.getFeeType(lane.origin, piecewiseFeeAddress)) ===
      OnchainTokenFeeType.OffchainQuotedPiecewiseLinearFee,
    `Lane ${lane.id} explicit fee leaf is not OffchainQuotedPiecewiseLinearFee`,
  );
  const metadata = await reader.getPiecewiseMetadata(
    lane.origin,
    piecewiseFeeAddress,
  );
  return {
    laneId: lane.id,
    origin: lane.origin,
    sourceRouteId: lane.sourceRouteId,
    sourceRouter: source.address,
    sourceToken: source.symbol,
    destination: lane.destination,
    destDomain,
    targetRouteId: lane.targetRouteId,
    targetRouter: target.address,
    routingFeeAddress,
    piecewiseFeeAddress,
    ...metadata,
  };
}

export class EvmLaneOnchainReader implements LaneOnchainReader {
  constructor(private readonly multiProvider: MultiProvider) {}

  getDomainId(chain: string): number {
    return this.multiProvider.getDomainId(chain);
  }

  async getFeeRecipient(origin: string, sourceRouter: string): Promise<string> {
    return TokenRouter__factory.connect(
      sourceRouter,
      this.multiProvider.getProvider(origin),
    ).feeRecipient();
  }

  async getFeeType(origin: string, feeAddress: string): Promise<number> {
    return BaseFee__factory.connect(
      feeAddress,
      this.multiProvider.getProvider(origin),
    ).feeType();
  }

  async getExplicitFeeContract(
    origin: string,
    routingFeeAddress: string,
    destination: number,
    targetRouter: string,
  ): Promise<string> {
    return CrossCollateralRoutingFee__factory.connect(
      routingFeeAddress,
      this.multiProvider.getProvider(origin),
    ).feeContracts(destination, addressToBytes32(targetRouter));
  }

  async getPiecewiseMetadata(
    origin: string,
    feeAddress: string,
  ): Promise<{ feeToken: string; maxBands: number; tokenDecimals: number }> {
    const provider = this.multiProvider.getProvider(origin);
    const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
      feeAddress,
      provider,
    );
    const [feeToken, maxBands] = await Promise.all([
      fee.token(),
      fee.maxBands(),
    ]);
    const tokenDecimals = await IERC20Metadata__factory.connect(
      feeToken,
      provider,
    ).decimals();
    return { feeToken, maxBands, tokenDecimals };
  }
}

export function prepareLaneUpdate(
  lane: PiecewiseLaneConfig,
  slot: PiecewiseLaneSlot,
  mode: PublisherMode,
): PreparedLaneUpdate {
  if (mode === 'standing') {
    assert(lane.standing, `Selected lane ${lane.id} has no standing curve`);
    return {
      mode,
      laneIds: [lane.id],
      slot,
      curve: materializeStandingCurve(
        lane.standing,
        slot.tokenDecimals,
        slot.maxBands,
      ),
    };
  }
  return {
    mode,
    laneIds: [lane.id],
    slot,
    curve: materializeFallbackCurve(
      lane.fallback,
      slot.tokenDecimals,
      slot.maxBands,
    ),
  };
}

export function encodeStandingCurveData(
  curve: MaterializedStandingCurve,
): string {
  return ethers.utils.defaultAbiCoder.encode(
    ['uint128[]', 'uint32[]', 'uint32', 'uint32[]'],
    [
      curve.breakpoints,
      curve.marginalBpsX1e4,
      curve.staleAfterSeconds,
      curve.staleMarginalSurchargeBpsX1e4,
    ],
  );
}

export function encodeFallbackCurveData(curve: MaterializedCurve): string {
  return ethers.utils.defaultAbiCoder.encode(
    ['uint128[]', 'uint32[]'],
    [curve.breakpoints, curve.marginalBpsX1e4],
  );
}

function updateKey(update: PreparedLaneUpdate): string {
  const contract = update.slot.piecewiseFeeAddress.toLowerCase();
  return update.mode === 'standing'
    ? `${update.slot.origin}:${contract}:${update.slot.destDomain}`
    : `${update.slot.origin}:${contract}`;
}

function updateData(update: PreparedLaneUpdate): string {
  return update.mode === 'standing'
    ? ethers.utils.defaultAbiCoder.encode(
        ['bytes', 'uint32'],
        [encodeStandingCurveData(update.curve), update.curve.ttlSeconds],
      )
    : encodeFallbackCurveData(update.curve);
}

export function deduplicatePreparedUpdates(
  updates: PreparedLaneUpdate[],
): PreparedLaneUpdate[] {
  const unique = new Map<string, PreparedLaneUpdate>();
  for (const update of updates) {
    const key = updateKey(update);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, update);
      continue;
    }
    assert(
      updateData(previous) === updateData(update),
      `Lanes ${previous.laneIds.join(',')} and ${update.laneIds.join(',')} configure conflicting updates for ${key}`,
    );
    previous.laneIds.push(...update.laneIds);
  }
  return [...unique.values()];
}

function arraysEqual(
  actual: readonly ethers.BigNumberish[],
  expected: readonly ethers.BigNumberish[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) =>
      ethers.BigNumber.from(value).eq(expected[index]),
    )
  );
}

export async function getLatestBlockTimestamp(
  multiProvider: MultiProvider,
  origin: string,
): Promise<number> {
  const block = await multiProvider.getProvider(origin).getBlock('latest');
  assert(block, `Latest block unavailable for ${origin}`);
  return block.timestamp;
}

export async function verifyPiecewiseSignerAuthorization(
  multiProvider: MultiProvider,
  signerKey: string,
  updates: PreparedLaneUpdate[],
): Promise<void> {
  const signerAddress = new Wallet(signerKey).address;
  for (const update of deduplicatePreparedUpdates(updates)) {
    const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
      update.slot.piecewiseFeeAddress,
      multiProvider.getProvider(update.slot.origin),
    );
    assert(
      await fee.isQuoteSigner(signerAddress),
      `Signer ${signerAddress} is unauthorized on ${update.slot.origin}:${update.slot.piecewiseFeeAddress}`,
    );
  }
}

function buildStandingQuote(
  update: Extract<PreparedLaneUpdate, { mode: 'standing' }>,
  issuedAt: number,
  submitter: string,
) {
  assert(
    issuedAt + update.curve.ttlSeconds <= MAX_UINT48,
    `Standing expiry exceeds uint48 for ${update.laneIds.join(',')}`,
  );
  return {
    context: ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'uint256'],
      [update.slot.destDomain, WILDCARD_RECIPIENT, constants.MaxUint256],
    ),
    data: encodeStandingCurveData(update.curve),
    issuedAt,
    expiry: issuedAt + update.curve.ttlSeconds,
    salt: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    submitter,
  };
}

export async function submitPreparedUpdate(
  multiProvider: MultiProvider,
  signerKey: string,
  submitterWallet: Wallet,
  update: PreparedLaneUpdate,
): Promise<SubmissionResult> {
  const provider = multiProvider.getProvider(update.slot.origin);
  const { chainId } = await provider.getNetwork();
  const issuedAt = await getLatestBlockTimestamp(
    multiProvider,
    update.slot.origin,
  );
  const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
    update.slot.piecewiseFeeAddress,
    submitterWallet.connect(provider),
  );
  if (update.mode === 'standing') {
    const quote = buildStandingQuote(update, issuedAt, submitterWallet.address);
    const existing = await fee.getCurve(
      update.slot.destDomain,
      WILDCARD_RECIPIENT,
    );
    const existingIssuedAt = ethers.BigNumber.from(
      existing.issuedAt,
    ).toNumber();
    assert(existingIssuedAt <= issuedAt, 'Onchain standing curve is newer');
    if (existingIssuedAt === issuedAt) {
      const unchanged =
        arraysEqual(existing.breakpoints, update.curve.breakpoints) &&
        arraysEqual(existing.marginalBpsX1e4, update.curve.marginalBpsX1e4) &&
        arraysEqual(
          existing.staleMarginalSurchargeBpsX1e4,
          update.curve.staleMarginalSurchargeBpsX1e4,
        ) &&
        ethers.BigNumber.from(existing.staleAfterSeconds).eq(
          update.curve.staleAfterSeconds,
        ) &&
        ethers.BigNumber.from(existing.expiry).eq(quote.expiry);
      assert(unchanged, `Conflicting standing curve at issuedAt ${issuedAt}`);
      return { status: 'unchanged' };
    }
    const signature = await new Wallet(signerKey)._signTypedData(
      {
        name: EIP712_NAME,
        version: EIP712_VERSION,
        chainId,
        verifyingContract: update.slot.piecewiseFeeAddress,
      },
      SIGNED_QUOTE_TYPES,
      quote,
    );
    const tx = await fee.submitQuote(
      quote,
      signature,
      multiProvider.getTransactionOverrides(update.slot.origin),
    );
    const receipt = await tx.wait(1);
    assert(
      receipt.events?.some((event) => event.event === 'QuoteSubmitted'),
      `QuoteSubmitted event missing from ${tx.hash}`,
    );
    const stored = await fee.getCurve(
      update.slot.destDomain,
      WILDCARD_RECIPIENT,
    );
    assert(
      ethers.BigNumber.from(stored.issuedAt).eq(issuedAt) &&
        ethers.BigNumber.from(stored.expiry).eq(quote.expiry) &&
        arraysEqual(stored.breakpoints, update.curve.breakpoints) &&
        arraysEqual(stored.marginalBpsX1e4, update.curve.marginalBpsX1e4) &&
        arraysEqual(
          stored.staleMarginalSurchargeBpsX1e4,
          update.curve.staleMarginalSurchargeBpsX1e4,
        ) &&
        ethers.BigNumber.from(stored.staleAfterSeconds).eq(
          update.curve.staleAfterSeconds,
        ),
      `Standing curve readback failed for ${update.laneIds.join(',')}`,
    );
    return { status: 'submitted', txHash: tx.hash };
  }

  const fallback = {
    data: encodeFallbackCurveData(update.curve),
    issuedAt,
    submitter: submitterWallet.address,
  };
  const existing = await fee.getFallbackCurve();
  const existingIssuedAt = ethers.BigNumber.from(existing.issuedAt).toNumber();
  assert(existingIssuedAt <= issuedAt, 'Onchain fallback curve is newer');
  if (existingIssuedAt === issuedAt) {
    const unchanged =
      arraysEqual(existing.breakpoints, update.curve.breakpoints) &&
      arraysEqual(existing.marginalBpsX1e4, update.curve.marginalBpsX1e4);
    assert(unchanged, `Conflicting fallback curve at issuedAt ${issuedAt}`);
    return { status: 'unchanged' };
  }
  const signature = await new Wallet(signerKey)._signTypedData(
    {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: update.slot.piecewiseFeeAddress,
    },
    SIGNED_FALLBACK_CURVE_TYPES,
    fallback,
  );
  const tx = await fee.submitFallbackCurve(
    fallback,
    signature,
    multiProvider.getTransactionOverrides(update.slot.origin),
  );
  const receipt = await tx.wait(1);
  assert(
    receipt.events?.some((event) => event.event === 'FallbackCurveSubmitted'),
    `FallbackCurveSubmitted event missing from ${tx.hash}`,
  );
  const stored = await fee.getFallbackCurve();
  assert(
    ethers.BigNumber.from(stored.issuedAt).eq(issuedAt) &&
      arraysEqual(stored.breakpoints, update.curve.breakpoints) &&
      arraysEqual(stored.marginalBpsX1e4, update.curve.marginalBpsX1e4),
    `Fallback curve readback failed for ${update.laneIds.join(',')}`,
  );
  return { status: 'submitted', txHash: tx.hash };
}

export interface RunPublisherOptions {
  updates: PreparedLaneUpdate[];
  submit: boolean;
  submitterLabel: string;
  getTimestamp(origin: string): Promise<number>;
  submitUpdate?(update: PreparedLaneUpdate): Promise<SubmissionResult>;
  log(line: string): void;
}

export async function runPublisherUpdates(
  options: RunPublisherOptions,
): Promise<SubmissionResult[]> {
  const updates = deduplicatePreparedUpdates(options.updates);
  const timestamps = new Map(
    await Promise.all(
      [...new Set(updates.map((update) => update.slot.origin))].map(
        async (origin) => [origin, await options.getTimestamp(origin)] as const,
      ),
    ),
  );
  options.log(
    `${options.submit ? 'SUBMIT' : 'DRY RUN'}: ${updates.length} ${updates[0]?.mode ?? ''} update(s)`,
  );
  for (const update of updates) {
    const issuedAt = timestamps.get(update.slot.origin);
    assert(
      issuedAt !== undefined,
      `Missing timestamp for ${update.slot.origin}`,
    );
    const curve = update.curve;
    const timing =
      update.mode === 'standing'
        ? ` staleAt=${issuedAt + update.curve.staleAfterSeconds} expiry=${issuedAt + update.curve.ttlSeconds}`
        : '';
    options.log(
      `lanes=[${update.laneIds.join(',')}] ${update.slot.origin}:${update.slot.sourceRouteId}` +
        ` -> ${update.slot.destination}:${update.slot.targetRouteId}` +
        ` target=${update.slot.targetRouter} fee=${update.slot.piecewiseFeeAddress}` +
        ` submitter=${options.submitterLabel} issuedAt=${issuedAt}${timing}` +
        ` breakpoints=[${curve.breakpoints.join(',')}] ratesX1e4=[${curve.marginalBpsX1e4.join(',')}]`,
    );
  }
  if (!options.submit) {
    options.log('Dry run complete. Pass --submit to sign and submit.');
    return [];
  }
  assert(options.submitUpdate, 'submitUpdate is required with --submit');
  const results: SubmissionResult[] = [];
  for (const update of updates) {
    results.push(await options.submitUpdate(update));
  }
  return results;
}
