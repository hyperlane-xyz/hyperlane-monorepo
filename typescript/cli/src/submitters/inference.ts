import {
  ISafe__factory,
  InterchainAccountRouter__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainName,
  type SubmitterMetadata,
  type TypedAnnotatedTransaction,
  PROPOSER_ROLE,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  assert,
  bytes32ToAddress,
  eqAddress,
  isAddressEvm,
  normalizeAddressEvm,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { readYamlOrJson } from '../utils/files.js';

import {
  type ExtendedChainSubmissionStrategy,
  type ExtendedSubmissionStrategy,
  ExtendedChainSubmissionStrategySchema,
  ExtendedSubmissionStrategySchema,
} from './types.js';

const logger = rootLogger.child({ module: 'submitter-inference' });
const MAX_INFERENCE_DEPTH = 3;
const EVM_ADDRESS_ZERO =
  '0x0000000000000000000000000000000000000000' as Address;
const KNOWN_PROTOCOL_TYPES = new Set<ProtocolType>(
  Object.values(ProtocolType) as ProtocolType[],
);
type InferredSubmitter = SubmitterMetadata;

type Cache = {
  safeByChainAndAddress: Map<string, boolean>;
  timelockByChainAndAddress: Map<string, boolean>;
  ownerByChainAndAddress: Map<string, Address | null>;
  icaByChainAndAddress: Map<string, InferredSubmitter | null>;
  timelockProposerByChainAndAddress: Map<string, InferredSubmitter>;
  signerByChain: Map<ChainName, boolean>;
  signerAddressByChain: Map<ChainName, Address | null>;
  providerByChain: Map<
    ChainName,
    ReturnType<WriteCommandContext['multiProvider']['getProvider']> | null
  >;
  protocolIsEthereumByChain: Map<string, boolean>;
  chainNameByDomain: Map<number, ChainName | null>;
  registryAddresses?: Awaited<
    ReturnType<WriteCommandContext['registry']['getAddresses']>
  >;
};

type InferSubmitterFromAddressParams = {
  chain: ChainName;
  address: Address;
  context: WriteCommandContext;
  cache: Cache;
  depth: number;
};

type InferTimelockProposerParams = {
  chain: ChainName;
  timelockAddress: Address;
  context: WriteCommandContext;
  cache: Cache;
  depth: number;
};

type InferIcaParams = {
  destinationChain: ChainName;
  accountAddress: Address;
  context: WriteCommandContext;
  cache: Cache;
  depth: number;
};

type ResolveSubmitterBatchesParams = {
  chain: ChainName;
  transactions: TypedAnnotatedTransaction[];
  context: WriteCommandContext;
  strategyUrl?: string;
  isExtendedChain?: boolean;
};

type ExplicitOverrideIndexes = {
  evmTargetOverrides: Map<string, ExtendedSubmissionStrategy['submitter']>;
  evmSelectorOverrides: Map<string, ExtendedSubmissionStrategy['submitter']>;
  nonEvmTargetOverrides: Map<string, ExtendedSubmissionStrategy['submitter']>;
};

export type ResolvedSubmitterBatch = {
  config: ExtendedSubmissionStrategy;
  transactions: TypedAnnotatedTransaction[];
};

function normalizeEvmAddressFlexible(address: string): string {
  const trimmed = address.trim();
  const normalizedPrefix = trimmed.startsWith('0X')
    ? `0x${trimmed.slice(2)}`
    : trimmed;
  assert(
    isAddressEvm(normalizedPrefix),
    `Invalid EVM address: ${normalizedPrefix}`,
  );
  return normalizeAddressEvm(normalizedPrefix.toLowerCase());
}

function cacheKey(chain: ChainName, address: Address): string {
  return `${chain}:${normalizeEvmAddressFlexible(address)}`;
}

const MAX_LOG_POSITION_STRING_LENGTH = 256;
const MAX_LOG_POSITION_RAW_STRING_LENGTH = 4096;
const MAX_HYPERLANE_DOMAIN_ID = 0xffffffff;
const LOG_POSITION_HEX_STRING_REGEX = /^0x[0-9a-f]+$/i;
const LOG_POSITION_DECIMAL_STRING_REGEX = /^[0-9]+$/;

function normalizeNumericStringForBigInt(
  value: string,
  isHex: boolean,
): string | null {
  if (isHex) {
    const normalizedBody = value.slice(2).replace(/^0+/, '');
    const normalizedHex = `0x${normalizedBody || '0'}`;
    if (normalizedHex.length > MAX_LOG_POSITION_STRING_LENGTH) {
      return null;
    }
    return normalizedHex;
  }

  const normalizedDecimal = value.replace(/^0+/, '') || '0';
  if (normalizedDecimal.length > MAX_LOG_POSITION_STRING_LENGTH) {
    return null;
  }
  return normalizedDecimal;
}

// Normalizes provider log position fields into exact non-negative integers.
// Accepts numbers (only safe integers), bigint, decimal/hex strings, and
// BigNumber-like objects with string `toString()`. Rejects malformed/unsafe
// values so invalid positions always sort before valid on-chain positions.
function toNonNegativeIntegerBigInt(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      !Number.isInteger(value) ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    return BigInt(value);
  }

  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_LOG_POSITION_RAW_STRING_LENGTH) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const isHex = LOG_POSITION_HEX_STRING_REGEX.test(trimmed);
    const isDecimal = LOG_POSITION_DECIMAL_STRING_REGEX.test(trimmed);
    if (!isHex && !isDecimal) {
      return null;
    }
    const normalized = normalizeNumericStringForBigInt(trimmed, isHex);
    if (!normalized) {
      return null;
    }
    try {
      const parsed = BigInt(normalized);
      return parsed >= 0n ? parsed : null;
    } catch {
      return null;
    }
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toString?: unknown }).toString === 'function'
  ) {
    let stringified: unknown;
    try {
      stringified = (value as { toString: () => unknown }).toString();
    } catch {
      return null;
    }
    if (typeof stringified !== 'string') {
      return null;
    }
    return toNonNegativeIntegerBigInt(stringified);
  }

  return null;
}

function compareLogPositionIndex(left: unknown, right: unknown): number {
  const leftIndex = toNonNegativeIntegerBigInt(left);
  const rightIndex = toNonNegativeIntegerBigInt(right);

  if (leftIndex === null) {
    return rightIndex === null ? 0 : -1;
  }
  if (rightIndex === null) {
    return 1;
  }
  if (leftIndex < rightIndex) {
    return -1;
  }
  if (leftIndex > rightIndex) {
    return 1;
  }
  return 0;
}

function compareLogsByPosition(
  a: { blockNumber?: unknown; transactionIndex?: unknown; logIndex?: unknown },
  b: { blockNumber?: unknown; transactionIndex?: unknown; logIndex?: unknown },
): number {
  const blockDiff = compareLogPositionIndex(a.blockNumber, b.blockNumber);
  if (blockDiff !== 0) {
    return blockDiff;
  }

  const txIndexDiff = compareLogPositionIndex(
    a.transactionIndex,
    b.transactionIndex,
  );
  if (txIndexDiff !== 0) {
    return txIndexDiff;
  }

  return compareLogPositionIndex(a.logIndex, b.logIndex);
}

/**
 * Signer availability probe with aggressive memoization and defensive narrowing.
 *
 * Why this exists:
 * - MultiProvider implementations in the wild return many `tryGetSigner` shapes:
 *   direct signer objects, promises, thenables, primitives, constructor functions,
 *   malformed objects, and values with throwing getters.
 * - Inference must never throw for malformed signer probes; it must degrade to
 *   "no signer" and ultimately JSON-RPC fallback.
 *
 * Rules:
 * - Cache by chain so repeated inference for mixed tx batches does one probe.
 * - Prefer `getSignerAddress` when available and valid.
 * - If signer address lookup fails, try best-effort `signer.getAddress()`.
 * - Treat zero address / malformed addresses as no signer.
 * - Catch all probe failures and degrade gracefully.
 */
async function hasSignerForChain(
  context: WriteCommandContext,
  cache: Cache,
  chain: ChainName,
): Promise<boolean> {
  const cached = cache.signerByChain.get(chain);
  if (cached !== undefined) {
    return cached;
  }

  const maybeTryGetSigner = getTryGetSignerMethod(context.multiProvider);
  if (typeof maybeTryGetSigner !== 'function') {
    const signerAddress = await getSignerAddressForChain(context, cache, chain);
    const hasSigner = !!signerAddress;
    cache.signerByChain.set(chain, hasSigner);
    return hasSigner;
  }

  try {
    const maybeSigner = maybeTryGetSigner.call(context.multiProvider, chain);
    const thenableHandler = getThenableHandler(maybeSigner);
    const signer =
      maybeSigner && typeof thenableHandler === 'function'
        ? await maybeSigner
        : maybeSigner;
    if (!signer) {
      cache.signerByChain.set(chain, false);
      return false;
    }

    const signerAddress = await getSignerAddressForChain(context, cache, chain);
    const fallbackSignerAddress = signerAddress
      ? signerAddress
      : await getSignerAddressFromSignerObject(signer);
    if (fallbackSignerAddress) {
      cache.signerAddressByChain.set(chain, fallbackSignerAddress);
    }
    const hasSigner = !!fallbackSignerAddress;
    cache.signerByChain.set(chain, hasSigner);
    return hasSigner;
  } catch {
    const signerAddress = await getSignerAddressForChain(context, cache, chain);
    const hasSigner = !!signerAddress;
    cache.signerByChain.set(chain, hasSigner);
    return hasSigner;
  }
}

function getTryGetSignerMethod(multiProvider: unknown): unknown {
  if (
    !multiProvider ||
    (typeof multiProvider !== 'object' && typeof multiProvider !== 'function')
  ) {
    return null;
  }

  try {
    return (multiProvider as { tryGetSigner?: unknown }).tryGetSigner;
  } catch {
    return null;
  }
}

function getThenableHandler(value: unknown): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }

  try {
    return (value as { then?: unknown }).then;
  } catch {
    return null;
  }
}

async function getSignerAddressFromSignerObject(
  signer: unknown,
): Promise<Address | null> {
  const maybeGetAddress = getSignerAddressMethod(signer);
  if (typeof maybeGetAddress !== 'function') {
    return null;
  }

  try {
    const signerAddress = await maybeGetAddress.call(signer);
    const normalizedSignerAddress = tryNormalizeEvmAddress(signerAddress);
    return normalizedSignerAddress &&
      !eqAddress(normalizedSignerAddress, EVM_ADDRESS_ZERO)
      ? (normalizedSignerAddress as Address)
      : null;
  } catch {
    return null;
  }
}

function getSignerAddressMethod(signer: unknown): unknown {
  if (!signer || (typeof signer !== 'object' && typeof signer !== 'function')) {
    return null;
  }

  try {
    return (signer as { getAddress?: unknown }).getAddress;
  } catch {
    return null;
  }
}

function isEthereumProtocolChain(
  context: WriteCommandContext,
  cache: Cache,
  chain: string,
): chain is ChainName {
  const cached = cache.protocolIsEthereumByChain.get(chain);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const isEthereum =
      context.multiProvider.getProtocol(chain as ChainName) ===
      ProtocolType.Ethereum;
    cache.protocolIsEthereumByChain.set(chain, isEthereum);
    return isEthereum;
  } catch {
    cache.protocolIsEthereumByChain.set(chain, false);
    return false;
  }
}

async function getRegistryAddresses(
  context: WriteCommandContext,
  cache: Cache,
): Promise<
  Awaited<ReturnType<WriteCommandContext['registry']['getAddresses']>>
> {
  if (cache.registryAddresses) {
    return cache.registryAddresses;
  }
  try {
    const registryAddresses = await context.registry.getAddresses();
    cache.registryAddresses = (registryAddresses ?? {}) as Awaited<
      ReturnType<WriteCommandContext['registry']['getAddresses']>
    >;
  } catch {
    cache.registryAddresses = {} as Awaited<
      ReturnType<WriteCommandContext['registry']['getAddresses']>
    >;
  }
  return cache.registryAddresses;
}

async function getSignerAddressForChain(
  context: WriteCommandContext,
  cache: Cache,
  chain: ChainName,
): Promise<Address | null> {
  if (cache.signerAddressByChain.has(chain)) {
    return cache.signerAddressByChain.get(chain) ?? null;
  }

  try {
    const signerAddress = await context.multiProvider.getSignerAddress(chain);
    const normalizedSignerAddress = tryNormalizeEvmAddress(signerAddress);
    const resolvedSignerAddress =
      normalizedSignerAddress &&
      !eqAddress(normalizedSignerAddress, EVM_ADDRESS_ZERO)
        ? (normalizedSignerAddress as Address)
        : null;
    cache.signerAddressByChain.set(chain, resolvedSignerAddress);
    return resolvedSignerAddress;
  } catch {
    cache.signerAddressByChain.set(chain, null);
    return null;
  }
}

function getChainNameForDomain(
  context: WriteCommandContext,
  cache: Cache,
  domain: number,
): ChainName | null {
  if (cache.chainNameByDomain.has(domain)) {
    return cache.chainNameByDomain.get(domain) ?? null;
  }

  try {
    const chainName = context.multiProvider.getChainName(domain);
    cache.chainNameByDomain.set(domain, chainName);
    return chainName;
  } catch {
    cache.chainNameByDomain.set(domain, null);
    return null;
  }
}

function getProviderForChain(
  context: WriteCommandContext,
  cache: Cache,
  chain: ChainName,
): ReturnType<WriteCommandContext['multiProvider']['getProvider']> | null {
  if (cache.providerByChain.has(chain)) {
    return cache.providerByChain.get(chain) ?? null;
  }

  try {
    const provider = context.multiProvider.getProvider(chain);
    cache.providerByChain.set(chain, provider);
    return provider;
  } catch {
    cache.providerByChain.set(chain, null);
    return null;
  }
}

async function getOwnerForTarget(
  context: WriteCommandContext,
  cache: Cache,
  chain: ChainName,
  target: Address,
): Promise<Address | null> {
  const ownerKey = cacheKey(chain, target);
  if (cache.ownerByChainAndAddress.has(ownerKey)) {
    return cache.ownerByChainAndAddress.get(ownerKey) ?? null;
  }

  const provider = getProviderForChain(context, cache, chain);
  if (!provider) {
    cache.ownerByChainAndAddress.set(ownerKey, null);
    return null;
  }

  try {
    const ownerAddress = await Ownable__factory.connect(
      target,
      provider,
    ).owner();
    const normalizedOwner = tryNormalizeEvmAddress(ownerAddress);
    const resolvedOwner =
      normalizedOwner && !eqAddress(normalizedOwner, EVM_ADDRESS_ZERO)
        ? normalizedOwner
        : null;
    cache.ownerByChainAndAddress.set(ownerKey, resolvedOwner);
    return resolvedOwner;
  } catch {
    cache.ownerByChainAndAddress.set(ownerKey, null);
    return null;
  }
}

function getDefaultSubmitter(chain: ChainName): ExtendedSubmissionStrategy {
  return {
    submitter: {
      chain,
      type: TxSubmitterType.JSON_RPC,
    },
  };
}

function readChainSubmissionStrategy(
  submissionStrategyFilepath: string,
): ExtendedChainSubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return ExtendedChainSubmissionStrategySchema.parse(
    submissionStrategyFileContent,
  );
}

async function isSafeContract({
  chain,
  address,
  context,
  cache,
}: {
  chain: ChainName;
  address: Address;
  context: WriteCommandContext;
  cache: Cache;
}): Promise<boolean> {
  const key = cacheKey(chain, address);
  const cached = cache.safeByChainAndAddress.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const provider = getProviderForChain(context, cache, chain);
  if (!provider) {
    cache.safeByChainAndAddress.set(key, false);
    return false;
  }

  try {
    const safe = ISafe__factory.connect(address, provider);
    await safe.getThreshold();
    cache.safeByChainAndAddress.set(key, true);
    return true;
  } catch {
    cache.safeByChainAndAddress.set(key, false);
    return false;
  }
}

async function isTimelockContract({
  chain,
  address,
  context,
  cache,
}: {
  chain: ChainName;
  address: Address;
  context: WriteCommandContext;
  cache: Cache;
}): Promise<boolean> {
  const key = cacheKey(chain, address);
  const cached = cache.timelockByChainAndAddress.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const provider = getProviderForChain(context, cache, chain);
  if (!provider) {
    cache.timelockByChainAndAddress.set(key, false);
    return false;
  }

  try {
    const timelock = TimelockController__factory.connect(address, provider);
    await timelock.getMinDelay();
    cache.timelockByChainAndAddress.set(key, true);
    return true;
  } catch {
    cache.timelockByChainAndAddress.set(key, false);
    return false;
  }
}

/**
 * Infer an ICA submitter for a destination-chain account address.
 *
 * Resolution order:
 * 1) parse destination `InterchainAccountCreated` logs (latest-first by exact
 *    block/tx/log position) and validate origin chain + signer availability
 * 2) fallback derivation via known origin routers and signer-owned owner
 *    candidates when event inference is unavailable/incomplete
 *
 * Guarantees:
 * - never throws for malformed logs, invalid domains, bad router fields, or
 *   missing providers; returns `null` and lets caller fallback to jsonRpc.
 * - caches both positive and negative outcomes per `(destinationChain, account)`.
 */
async function inferIcaSubmitterFromAccount({
  destinationChain,
  accountAddress,
  context,
  cache,
  depth,
}: InferIcaParams): Promise<InferredSubmitter | null> {
  if (depth >= MAX_INFERENCE_DEPTH) {
    return null;
  }

  const cacheId = cacheKey(destinationChain, accountAddress);
  if (cache.icaByChainAndAddress.has(cacheId)) {
    const cached = cache.icaByChainAndAddress.get(cacheId);
    return cached ?? null;
  }

  const registryAddresses = await getRegistryAddresses(context, cache);
  const destinationAddresses = registryAddresses[destinationChain];
  const destinationRouterAddress =
    destinationAddresses?.interchainAccountRouter;
  if (!destinationRouterAddress) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }
  const normalizedDestinationRouterAddress = tryNormalizeEvmAddress(
    destinationRouterAddress,
  );
  if (
    !normalizedDestinationRouterAddress ||
    eqAddress(normalizedDestinationRouterAddress, EVM_ADDRESS_ZERO)
  ) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }

  const provider = getProviderForChain(context, cache, destinationChain);
  if (!provider) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }
  const destinationRouter = InterchainAccountRouter__factory.connect(
    normalizedDestinationRouterAddress,
    provider,
  );

  const eventFilter =
    destinationRouter.filters.InterchainAccountCreated(accountAddress);
  let logs: Awaited<ReturnType<typeof provider.getLogs>>;
  try {
    logs = await provider.getLogs({
      ...eventFilter,
      fromBlock: 0,
      toBlock: 'latest',
    });
  } catch {
    logs = [];
  }

  const logsDescendingByPosition = [...logs].sort((a, b) =>
    compareLogsByPosition(b, a),
  );

  for (const log of logsDescendingByPosition) {
    let originDomain: number;
    let originRouter: Address;
    let owner: Address;
    let ism: Address;
    try {
      const parsed = destinationRouter.interface.parseLog(log);
      const normalizedOriginDomain = Number(parsed.args.origin);
      if (
        !Number.isSafeInteger(normalizedOriginDomain) ||
        normalizedOriginDomain < 0 ||
        normalizedOriginDomain > MAX_HYPERLANE_DOMAIN_ID
      ) {
        continue;
      }
      originDomain = normalizedOriginDomain;
      originRouter = bytes32ToAddress(parsed.args.router);
      owner = bytes32ToAddress(parsed.args.owner);
      if (
        eqAddress(originRouter, EVM_ADDRESS_ZERO) ||
        eqAddress(owner, EVM_ADDRESS_ZERO)
      ) {
        continue;
      }
      const normalizedIsm = tryNormalizeEvmAddress(parsed.args.ism as Address);
      if (!normalizedIsm) {
        continue;
      }
      ism = normalizedIsm as Address;
    } catch {
      continue;
    }

    const originChain = getChainNameForDomain(context, cache, originDomain);
    if (!originChain) {
      continue;
    }

    if (!(await hasSignerForChain(context, cache, originChain))) {
      continue;
    }

    let internalSubmitter: InferredSubmitter;
    try {
      internalSubmitter = await inferSubmitterFromAddress({
        chain: originChain,
        address: owner,
        context,
        cache,
        depth: depth + 1,
      });
    } catch {
      continue;
    }

    const submitter = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: originChain,
      destinationChain,
      owner,
      internalSubmitter,
      originInterchainAccountRouter: originRouter,
      destinationInterchainAccountRouter: normalizedDestinationRouterAddress,
      ...(eqAddress(ism, EVM_ADDRESS_ZERO)
        ? {}
        : { interchainSecurityModule: ism }),
    } satisfies Extract<
      InferredSubmitter,
      { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
    >;

    cache.icaByChainAndAddress.set(cacheId, submitter);
    return submitter;
  }

  // Fall back to deriving the ICA from signer owner and known routers,
  // to support routes where the ICA has not been deployed yet or when
  // event logs cannot be fully inferred.
  {
    const signerAddress = await getSignerAddressForChain(
      context,
      cache,
      destinationChain,
    );
    if (!signerAddress) {
      cache.icaByChainAndAddress.set(cacheId, null);
      return null;
    }
    const signerCandidates = [signerAddress];

    for (const ownerCandidate of signerCandidates) {
      for (const [originChain, originAddresses] of Object.entries(
        registryAddresses,
      )) {
        if (originChain === destinationChain) {
          continue;
        }

        if (!isEthereumProtocolChain(context, cache, originChain)) {
          continue;
        }

        const originRouterAddress = originAddresses?.interchainAccountRouter;
        if (!originRouterAddress) {
          continue;
        }
        const normalizedOriginRouterAddress =
          tryNormalizeEvmAddress(originRouterAddress);
        if (
          !normalizedOriginRouterAddress ||
          eqAddress(normalizedOriginRouterAddress, EVM_ADDRESS_ZERO)
        ) {
          continue;
        }

        try {
          if (!(await hasSignerForChain(context, cache, originChain))) {
            continue;
          }
          const originProvider = getProviderForChain(
            context,
            cache,
            originChain,
          );
          if (!originProvider) {
            continue;
          }

          const originRouter = InterchainAccountRouter__factory.connect(
            normalizedOriginRouterAddress,
            originProvider,
          );
          const derivedAccount = await originRouter[
            'getRemoteInterchainAccount(address,address,address)'
          ](
            ownerCandidate,
            normalizedDestinationRouterAddress,
            EVM_ADDRESS_ZERO,
          );
          const normalizedDerivedAccount =
            tryNormalizeEvmAddress(derivedAccount);
          if (
            !normalizedDerivedAccount ||
            eqAddress(normalizedDerivedAccount, EVM_ADDRESS_ZERO)
          ) {
            continue;
          }

          if (!eqAddress(normalizedDerivedAccount, accountAddress)) {
            continue;
          }

          const internalSubmitter = await inferSubmitterFromAddress({
            chain: originChain,
            address: ownerCandidate,
            context,
            cache,
            depth: depth + 1,
          });

          const submitter = {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: originChain,
            destinationChain,
            owner: ownerCandidate,
            internalSubmitter,
            originInterchainAccountRouter: normalizedOriginRouterAddress,
            destinationInterchainAccountRouter:
              normalizedDestinationRouterAddress,
          } satisfies Extract<
            InferredSubmitter,
            { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
          >;

          cache.icaByChainAndAddress.set(cacheId, submitter);
          return submitter;
        } catch {
          continue;
        }
      }
    }

    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }
}

/**
 * Infer proposer submitter for a TimelockController.
 *
 * Strategy:
 * - if signer can propose directly (open role or signer has proposer role):
 *   return jsonRpc.
 * - otherwise reconstruct current proposer set from RoleGranted/RoleRevoked logs
 *   and prefer:
 *   Safe proposer -> gnosisSafeTxBuilder
 *   ICA proposer -> interchainAccount (with inferred internal submitter)
 * - if role logs are incomplete, run signer-owned ICA derivation fallback and
 *   verify proposer role on derived ICA account.
 *
 * Failure behavior:
 * - any probe/read/parse error falls back to jsonRpc; result is memoized per
 *   `(chain, timelockAddress)` to prevent repeated noisy RPC probes.
 */
async function inferTimelockProposerSubmitter({
  chain,
  timelockAddress,
  context,
  cache,
  depth,
}: InferTimelockProposerParams): Promise<InferredSubmitter> {
  const timelockKey = cacheKey(chain, timelockAddress);
  const cached = cache.timelockProposerByChainAndAddress.get(timelockKey);
  if (cached) {
    return cached;
  }

  const defaultSubmitter: InferredSubmitter = {
    chain,
    type: TxSubmitterType.JSON_RPC,
  };

  if (depth >= MAX_INFERENCE_DEPTH) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  const signerAddress = await getSignerAddressForChain(context, cache, chain);
  if (!signerAddress) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }
  const provider = getProviderForChain(context, cache, chain);
  if (!provider) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }
  const timelock = TimelockController__factory.connect(
    timelockAddress,
    provider,
  );

  let isOpenProposerRole = false;
  let signerHasRole = false;
  try {
    [isOpenProposerRole, signerHasRole] = await Promise.all([
      timelock.hasRole(PROPOSER_ROLE, EVM_ADDRESS_ZERO),
      timelock.hasRole(PROPOSER_ROLE, signerAddress),
    ]);
  } catch {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  if (isOpenProposerRole || signerHasRole) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  let roleGrantedTopic: string;
  let roleRevokedTopic: string;
  try {
    roleGrantedTopic = timelock.interface.getEventTopic('RoleGranted');
    roleRevokedTopic = timelock.interface.getEventTopic('RoleRevoked');
  } catch {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  let grantedLogs: Awaited<ReturnType<typeof provider.getLogs>>;
  let revokedLogs: Awaited<ReturnType<typeof provider.getLogs>>;
  try {
    [grantedLogs, revokedLogs] = await Promise.all([
      provider.getLogs({
        address: timelockAddress,
        topics: [roleGrantedTopic, PROPOSER_ROLE],
        fromBlock: 0,
        toBlock: 'latest',
      }),
      provider.getLogs({
        address: timelockAddress,
        topics: [roleRevokedTopic, PROPOSER_ROLE],
        fromBlock: 0,
        toBlock: 'latest',
      }),
    ]);
  } catch {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  const roleLogs = [
    ...grantedLogs.map((log) => ({ log, isGrant: true })),
    ...revokedLogs.map((log) => ({ log, isGrant: false })),
  ].sort((a, b) => compareLogsByPosition(a.log, b.log));

  const granted = new Set<Address>();
  for (const roleLog of roleLogs) {
    try {
      const parsed = timelock.interface.parseLog(roleLog.log);
      const normalizedAccount = tryNormalizeEvmAddress(
        parsed.args.account as Address,
      );
      if (
        normalizedAccount &&
        !eqAddress(normalizedAccount, EVM_ADDRESS_ZERO)
      ) {
        if (roleLog.isGrant) {
          granted.add(normalizedAccount as Address);
        } else {
          granted.delete(normalizedAccount as Address);
        }
      }
    } catch {
      continue;
    }
  }

  const proposers = Array.from(granted).filter(
    (account) => !eqAddress(account, EVM_ADDRESS_ZERO),
  );
  const registryAddresses = await getRegistryAddresses(context, cache);
  const destinationRouterAddressCandidate = tryNormalizeEvmAddress(
    registryAddresses[chain]?.interchainAccountRouter ?? '',
  );
  const destinationRouterAddress =
    destinationRouterAddressCandidate &&
    !eqAddress(destinationRouterAddressCandidate, EVM_ADDRESS_ZERO)
      ? destinationRouterAddressCandidate
      : null;

  for (const proposer of proposers) {
    if (eqAddress(proposer, signerAddress)) {
      cache.timelockProposerByChainAndAddress.set(
        timelockKey,
        defaultSubmitter,
      );
      return defaultSubmitter;
    }

    if (
      await isSafeContract({
        chain,
        address: proposer,
        context,
        cache,
      })
    ) {
      const proposerSubmitter = {
        chain,
        type: TxSubmitterType.GNOSIS_TX_BUILDER,
        safeAddress: proposer,
        version: '1.0',
      } satisfies Extract<
        InferredSubmitter,
        { type: TxSubmitterType.GNOSIS_TX_BUILDER }
      >;
      cache.timelockProposerByChainAndAddress.set(
        timelockKey,
        proposerSubmitter,
      );
      return proposerSubmitter;
    }

    let inferredIca: InferredSubmitter | null = null;
    try {
      inferredIca = await inferIcaSubmitterFromAccount({
        destinationChain: chain,
        accountAddress: proposer,
        context,
        cache,
        depth: depth + 1,
      });
    } catch {
      inferredIca = null;
    }
    if (inferredIca) {
      cache.timelockProposerByChainAndAddress.set(timelockKey, inferredIca);
      return inferredIca;
    }

    if (destinationRouterAddress) {
      for (const [originChain, originAddresses] of Object.entries(
        registryAddresses,
      )) {
        const originChainName = originChain as ChainName;
        if (originChainName === chain) {
          continue;
        }
        if (!isEthereumProtocolChain(context, cache, originChainName)) {
          continue;
        }

        const originRouterAddress = originAddresses?.interchainAccountRouter;
        if (!originRouterAddress) {
          continue;
        }
        const normalizedOriginRouterAddress =
          tryNormalizeEvmAddress(originRouterAddress);
        if (
          !normalizedOriginRouterAddress ||
          eqAddress(normalizedOriginRouterAddress, EVM_ADDRESS_ZERO)
        ) {
          continue;
        }

        try {
          if (!(await hasSignerForChain(context, cache, originChainName))) {
            continue;
          }
          const originProvider = getProviderForChain(
            context,
            cache,
            originChainName,
          );
          if (!originProvider) {
            continue;
          }

          const originRouter = InterchainAccountRouter__factory.connect(
            normalizedOriginRouterAddress,
            originProvider,
          );
          const derivedIcaProposer = await originRouter[
            'getRemoteInterchainAccount(address,address,address)'
          ](signerAddress, destinationRouterAddress, EVM_ADDRESS_ZERO);
          const normalizedDerivedIcaProposer =
            tryNormalizeEvmAddress(derivedIcaProposer);
          if (
            !normalizedDerivedIcaProposer ||
            eqAddress(normalizedDerivedIcaProposer, EVM_ADDRESS_ZERO)
          ) {
            continue;
          }

          if (!eqAddress(normalizedDerivedIcaProposer, proposer)) {
            continue;
          }

          const internalSubmitter = await inferSubmitterFromAddress({
            chain: originChainName,
            address: signerAddress,
            context,
            cache,
            depth: depth + 1,
          });
          const fallbackIcaSubmitter = {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: originChainName,
            destinationChain: chain,
            owner: signerAddress,
            internalSubmitter,
            originInterchainAccountRouter: normalizedOriginRouterAddress,
            destinationInterchainAccountRouter: destinationRouterAddress,
          } satisfies Extract<
            InferredSubmitter,
            { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
          >;
          cache.timelockProposerByChainAndAddress.set(
            timelockKey,
            fallbackIcaSubmitter,
          );
          return fallbackIcaSubmitter;
        } catch {
          continue;
        }
      }
    }
  }

  // Fallback path for nodes/environments where AccessControl role events
  // may be incomplete: derive signer-owned ICA accounts and check proposer role.
  if (destinationRouterAddress) {
    for (const [originChain, originAddresses] of Object.entries(
      registryAddresses,
    )) {
      const originChainName = originChain as ChainName;
      if (originChainName === chain) {
        continue;
      }
      if (!isEthereumProtocolChain(context, cache, originChainName)) {
        continue;
      }

      const originRouterAddress = originAddresses?.interchainAccountRouter;
      if (!originRouterAddress) {
        continue;
      }
      const normalizedOriginRouterAddress =
        tryNormalizeEvmAddress(originRouterAddress);
      if (
        !normalizedOriginRouterAddress ||
        eqAddress(normalizedOriginRouterAddress, EVM_ADDRESS_ZERO)
      ) {
        continue;
      }

      try {
        if (!(await hasSignerForChain(context, cache, originChainName))) {
          continue;
        }
        const originProvider = getProviderForChain(
          context,
          cache,
          originChainName,
        );
        if (!originProvider) {
          continue;
        }

        const originRouter = InterchainAccountRouter__factory.connect(
          normalizedOriginRouterAddress,
          originProvider,
        );
        const derivedIcaProposer = await originRouter[
          'getRemoteInterchainAccount(address,address,address)'
        ](signerAddress, destinationRouterAddress, EVM_ADDRESS_ZERO);
        const normalizedDerivedIcaProposer =
          tryNormalizeEvmAddress(derivedIcaProposer);
        if (
          !normalizedDerivedIcaProposer ||
          eqAddress(normalizedDerivedIcaProposer, EVM_ADDRESS_ZERO)
        ) {
          continue;
        }

        if (
          !(await timelock.hasRole(PROPOSER_ROLE, normalizedDerivedIcaProposer))
        ) {
          continue;
        }

        const inferredIca = await inferIcaSubmitterFromAccount({
          destinationChain: chain,
          accountAddress: normalizedDerivedIcaProposer,
          context,
          cache,
          depth: depth + 1,
        });

        if (inferredIca) {
          cache.timelockProposerByChainAndAddress.set(timelockKey, inferredIca);
          return inferredIca;
        }

        const internalSubmitter = await inferSubmitterFromAddress({
          chain: originChainName,
          address: signerAddress,
          context,
          cache,
          depth: depth + 1,
        });
        const fallbackIcaSubmitter = {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: originChainName,
          destinationChain: chain,
          owner: signerAddress,
          internalSubmitter,
          originInterchainAccountRouter: normalizedOriginRouterAddress,
          destinationInterchainAccountRouter: destinationRouterAddress,
        } satisfies Extract<
          InferredSubmitter,
          { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
        >;
        cache.timelockProposerByChainAndAddress.set(
          timelockKey,
          fallbackIcaSubmitter,
        );
        return fallbackIcaSubmitter;
      } catch {
        continue;
      }
    }
  }

  cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
  return defaultSubmitter;
}

/**
 * Infer the controlling submitter for an on-chain owner address.
 *
 * Order:
 * - signer / zero address / recursion limit => jsonRpc
 * - Safe owner => gnosisSafeTxBuilder
 * - Timelock owner => timelockController with inferred proposer submitter
 * - ICA account => interchainAccount with inferred internal submitter
 * - unknown owner type => jsonRpc
 *
 * This function is deliberately conservative: inability to prove a richer
 * submitter shape is treated as jsonRpc, not as an inference error.
 */
async function inferSubmitterFromAddress({
  chain,
  address,
  context,
  cache,
  depth,
}: InferSubmitterFromAddressParams): Promise<InferredSubmitter> {
  const defaultSubmitter: InferredSubmitter = {
    chain,
    type: TxSubmitterType.JSON_RPC,
  };

  if (depth >= MAX_INFERENCE_DEPTH) {
    return defaultSubmitter;
  }

  if (eqAddress(address, EVM_ADDRESS_ZERO)) {
    return defaultSubmitter;
  }

  const signerAddress = await getSignerAddressForChain(context, cache, chain);
  if (!signerAddress) {
    return defaultSubmitter;
  }
  if (eqAddress(address, signerAddress)) {
    return defaultSubmitter;
  }

  if (
    await isSafeContract({
      chain,
      address,
      context,
      cache,
    })
  ) {
    return {
      chain,
      type: TxSubmitterType.GNOSIS_TX_BUILDER,
      safeAddress: address,
      version: '1.0',
    } satisfies Extract<
      InferredSubmitter,
      { type: TxSubmitterType.GNOSIS_TX_BUILDER }
    >;
  }

  if (
    await isTimelockContract({
      chain,
      address,
      context,
      cache,
    })
  ) {
    const proposerSubmitter = await inferTimelockProposerSubmitter({
      chain,
      timelockAddress: address,
      context,
      cache,
      depth: depth + 1,
    });

    return {
      chain,
      type: TxSubmitterType.TIMELOCK_CONTROLLER,
      timelockAddress: address,
      proposerSubmitter,
    } satisfies Extract<
      InferredSubmitter,
      { type: TxSubmitterType.TIMELOCK_CONTROLLER }
    >;
  }

  let inferredIca: InferredSubmitter | null = null;
  try {
    inferredIca = await inferIcaSubmitterFromAccount({
      destinationChain: chain,
      accountAddress: address,
      context,
      cache,
      depth: depth + 1,
    });
  } catch {
    inferredIca = null;
  }
  if (inferredIca) {
    return inferredIca;
  }

  return defaultSubmitter;
}

async function inferSubmitterFromTransaction({
  protocol,
  chain,
  transaction,
  context,
  cache,
}: {
  protocol: ProtocolType;
  chain: ChainName;
  transaction: TypedAnnotatedTransaction;
  context: WriteCommandContext;
  cache: Cache;
}): Promise<ExtendedSubmissionStrategy> {
  const defaultSubmitter = getDefaultSubmitter(chain);

  if (protocol !== ProtocolType.Ethereum) {
    return defaultSubmitter;
  }

  const to = (transaction as any).to;
  const from = (transaction as any).from;
  if (!to || typeof to !== 'string') {
    return defaultSubmitter;
  }

  const normalizedTarget = tryNormalizeEvmAddress(to);
  const normalizedFrom =
    typeof from === 'string' ? tryNormalizeEvmAddress(from) : null;
  if (!normalizedTarget && !normalizedFrom) {
    return defaultSubmitter;
  }
  const normalizedOwner = normalizedTarget
    ? await getOwnerForTarget(context, cache, chain, normalizedTarget)
    : null;
  const addressToInferFrom =
    normalizedOwner ?? normalizedFrom ?? normalizedTarget;

  if (!addressToInferFrom) {
    return defaultSubmitter;
  }

  const inferredSubmitter = await inferSubmitterFromAddress({
    chain,
    address: addressToInferFrom,
    context,
    cache,
    depth: 0,
  });

  return ExtendedSubmissionStrategySchema.parse({
    submitter: inferredSubmitter,
  });
}

function getConfigFingerprint(config: ExtendedSubmissionStrategy): string {
  return JSON.stringify(config.submitter, (_key, value) =>
    typeof value === 'bigint' ? `${value.toString()}n` : value,
  );
}

function parseOverrideKey(key: string): { target: string; selector?: string } {
  const trimmedKey = key.trim();
  const parts = trimmedKey.split('@');
  if (parts.length !== 2) {
    return { target: trimmedKey };
  }

  const [target, maybeSelector] = parts.map((part) => part.trim());
  const normalizedSelector = maybeSelector.toLowerCase();
  if (/^0x[0-9a-f]{8}$/.test(normalizedSelector)) {
    return { target, selector: normalizedSelector };
  }
  return { target: trimmedKey };
}

function tryNormalizeEvmAddress(address: string): string | null {
  try {
    return normalizeEvmAddressFlexible(address);
  } catch {
    return null;
  }
}

function getTxSelector(tx: TypedAnnotatedTransaction): string | undefined {
  const data = (tx as any).data;
  if (typeof data !== 'string') {
    return undefined;
  }

  const normalizedData = data.trim().toLowerCase();
  if (!/^0x[0-9a-f]{8}/.test(normalizedData)) {
    return undefined;
  }
  return normalizedData.slice(0, 10).toLowerCase();
}

function buildExplicitOverrideIndexes({
  protocol,
  overrides,
}: {
  protocol: ProtocolType;
  overrides?: ExtendedSubmissionStrategy['submitterOverrides'];
}): ExplicitOverrideIndexes {
  const indexes: ExplicitOverrideIndexes = {
    evmTargetOverrides: new Map(),
    evmSelectorOverrides: new Map(),
    nonEvmTargetOverrides: new Map(),
  };

  if (!overrides) {
    return indexes;
  }

  for (const [overrideKey, submitter] of Object.entries(overrides)) {
    if (protocol === ProtocolType.Ethereum) {
      const parsed = parseOverrideKey(overrideKey);
      if (!parsed.target.trim()) {
        logger.debug(
          `Skipping empty EVM submitter override key for ${submitter.chain}`,
        );
        continue;
      }
      const normalizedTarget = tryNormalizeEvmAddress(parsed.target);
      if (!normalizedTarget) {
        logger.debug(
          `Skipping invalid EVM submitter override key '${overrideKey}' for ${submitter.chain}`,
        );
        continue;
      }

      if (parsed.selector) {
        const selectorKey = `${normalizedTarget}@${parsed.selector}`;
        if (!indexes.evmSelectorOverrides.has(selectorKey)) {
          indexes.evmSelectorOverrides.set(selectorKey, submitter);
        }
      } else if (!indexes.evmTargetOverrides.has(normalizedTarget)) {
        indexes.evmTargetOverrides.set(normalizedTarget, submitter);
      }
      continue;
    }

    const normalizedTarget = overrideKey.trim();
    if (!normalizedTarget) {
      logger.debug(
        `Skipping empty non-EVM submitter override key for ${submitter.chain}`,
      );
      continue;
    }
    if (normalizedTarget.includes('@')) {
      logger.debug(
        `Skipping selector-style non-EVM submitter override key '${overrideKey}' for ${submitter.chain}`,
      );
      continue;
    }
    if (!indexes.nonEvmTargetOverrides.has(normalizedTarget)) {
      indexes.nonEvmTargetOverrides.set(normalizedTarget, submitter);
    }
  }

  return indexes;
}

function resolveExplicitSubmitterForTransaction({
  protocol,
  transaction,
  explicitSubmissionStrategy,
  explicitOverrideIndexes,
}: {
  protocol: ProtocolType;
  transaction: TypedAnnotatedTransaction;
  explicitSubmissionStrategy: ExtendedSubmissionStrategy;
  explicitOverrideIndexes: ExplicitOverrideIndexes;
}): ExtendedSubmissionStrategy {
  const to = (transaction as any).to;
  const overrides = explicitSubmissionStrategy.submitterOverrides;

  if (!overrides || !to || typeof to !== 'string') {
    return ExtendedSubmissionStrategySchema.parse({
      submitter: explicitSubmissionStrategy.submitter,
    });
  }

  let selectedSubmitter = explicitSubmissionStrategy.submitter;
  if (protocol === ProtocolType.Ethereum) {
    const normalizedTarget = tryNormalizeEvmAddress(to.trim());
    if (!normalizedTarget) {
      return ExtendedSubmissionStrategySchema.parse({
        submitter: explicitSubmissionStrategy.submitter,
      });
    }
    const selector = getTxSelector(transaction);

    if (selector) {
      const selectorMatch = explicitOverrideIndexes.evmSelectorOverrides.get(
        `${normalizedTarget}@${selector}`,
      );
      if (selectorMatch) {
        selectedSubmitter = selectorMatch;
      }
    }

    if (selectedSubmitter === explicitSubmissionStrategy.submitter) {
      const targetMatch =
        explicitOverrideIndexes.evmTargetOverrides.get(normalizedTarget);
      if (targetMatch) {
        selectedSubmitter = targetMatch;
      }
    }
  } else {
    const normalizedTarget = to.trim();
    const targetMatch =
      explicitOverrideIndexes.nonEvmTargetOverrides.get(normalizedTarget);
    if (targetMatch) {
      selectedSubmitter = targetMatch;
    }
  }

  return ExtendedSubmissionStrategySchema.parse({
    submitter: selectedSubmitter,
  });
}

function hasNonEmptyStringTarget(
  transaction: TypedAnnotatedTransaction,
): boolean {
  const to = (transaction as any).to;
  return typeof to === 'string' && to.trim().length > 0;
}

function hasUsableOverrideKeys(
  overrides?: ExtendedSubmissionStrategy['submitterOverrides'],
): boolean {
  if (!overrides) {
    return false;
  }

  return Object.keys(overrides).some((overrideKey) => overrideKey.trim().length > 0);
}

function coerceKnownProtocolType(
  protocol: unknown,
): ProtocolType | undefined {
  return KNOWN_PROTOCOL_TYPES.has(protocol as ProtocolType)
    ? (protocol as ProtocolType)
    : undefined;
}

function createCache(): Cache {
  return {
    safeByChainAndAddress: new Map(),
    timelockByChainAndAddress: new Map(),
    ownerByChainAndAddress: new Map(),
    icaByChainAndAddress: new Map(),
    timelockProposerByChainAndAddress: new Map(),
    signerByChain: new Map(),
    signerAddressByChain: new Map(),
    providerByChain: new Map(),
    protocolIsEthereumByChain: new Map(),
    chainNameByDomain: new Map(),
  };
}

/**
 * Resolve submitter config per transaction and emit ordered contiguous batches.
 *
 * Precedence (strict):
 * 1) explicit strategy submitter / overrides (if provided and chain is non-extended)
 * 2) inferred submitter from on-chain ownership + governance topology
 * 3) jsonRpc default for the destination chain
 *
 * Inference model:
 * - EVM only; non-EVM chains always use JSON-RPC default.
 * - Probe tx target owner (with `tx.from` fallback when owner lookup is unavailable).
 * - Infer submitter shape recursively: signer => jsonRpc, Safe =>
 *   gnosisSafeTxBuilder, Timelock => timelockController(+proposer submitter),
 *   ICA => interchainAccount(+internal submitter).
 * - Enforce depth limit to prevent recursive inference loops.
 *
 * Batching model:
 * - Transactions are never reordered.
 * - Adjacent transactions with identical submitter fingerprint are coalesced.
 * - Same submitter appearing later creates a new batch to preserve nonce/order semantics.
 *
 * Fault tolerance:
 * - Any probe/inference error degrades that transaction to jsonRpc fallback.
 * - Caches memoize negative lookups and failures to avoid repeated RPC churn.
 */
export async function resolveSubmitterBatchesForTransactions({
  chain,
  transactions,
  context,
  strategyUrl,
  isExtendedChain,
}: ResolveSubmitterBatchesParams): Promise<ResolvedSubmitterBatch[]> {
  if (transactions.length === 0) {
    return [];
  }

  if (isExtendedChain) {
    return [
      {
        config: getDefaultSubmitter(chain),
        transactions,
      },
    ];
  }

  const normalizedStrategyUrl =
    typeof strategyUrl === 'string' ? strategyUrl.trim() : undefined;
  const explicitSubmissionStrategy: ExtendedSubmissionStrategy | undefined =
    normalizedStrategyUrl
      ? readChainSubmissionStrategy(normalizedStrategyUrl)[chain]
      : undefined;
  const explicitOverrides = explicitSubmissionStrategy?.submitterOverrides;
  const hasExplicitOverrides = hasUsableOverrideKeys(explicitOverrides);
  const hasOverrideEligibleTarget = transactions.some(hasNonEmptyStringTarget);

  if (
    explicitSubmissionStrategy &&
    (!hasExplicitOverrides || !hasOverrideEligibleTarget)
  ) {
    return [
      {
        config: ExtendedSubmissionStrategySchema.parse({
          submitter: explicitSubmissionStrategy.submitter,
        }),
        transactions,
      },
    ];
  }

  let protocol: ProtocolType | undefined;
  try {
    protocol = coerceKnownProtocolType(context.multiProvider.getProtocol(chain));
    if (!protocol) {
      logger.debug(
        `Falling back to default protocol handling for ${chain}: unknown protocol type`,
      );
    }
  } catch (error) {
    logger.debug(
      `Falling back to default protocol handling for ${chain}`,
      error,
    );
    protocol = undefined;
  }

  if (explicitSubmissionStrategy) {
    if (!protocol) {
      return [
        {
          config: ExtendedSubmissionStrategySchema.parse({
            submitter: explicitSubmissionStrategy.submitter,
          }),
          transactions,
        },
      ];
    }

    const explicitOverrideIndexes = buildExplicitOverrideIndexes({
      protocol,
      overrides: explicitSubmissionStrategy.submitterOverrides,
    });
    const batches: ResolvedSubmitterBatch[] = [];
    let lastBatchFingerprint: string | null = null;

    for (const transaction of transactions) {
      const selectedConfig = resolveExplicitSubmitterForTransaction({
        protocol,
        transaction,
        explicitSubmissionStrategy,
        explicitOverrideIndexes,
      });
      const fingerprint = getConfigFingerprint(selectedConfig);

      // Preserve transaction execution order by only coalescing
      // adjacent transactions that share the same submitter config.
      if (batches.length > 0 && lastBatchFingerprint === fingerprint) {
        batches[batches.length - 1].transactions.push(transaction);
      } else {
        batches.push({
          config: selectedConfig,
          transactions: [transaction],
        });
        lastBatchFingerprint = fingerprint;
      }
    }

    return batches;
  }

  if (protocol !== ProtocolType.Ethereum) {
    return [
      {
        config: getDefaultSubmitter(chain),
        transactions,
      },
    ];
  }

  const cache = createCache();
  const batches: ResolvedSubmitterBatch[] = [];
  let lastBatchFingerprint: string | null = null;

  for (const transaction of transactions) {
    let inferred: ExtendedSubmissionStrategy;
    try {
      inferred = await inferSubmitterFromTransaction({
        protocol,
        chain,
        transaction,
        context,
        cache,
      });
    } catch (error) {
      logger.debug(
        `Falling back to jsonRpc submitter inference for ${chain}`,
        error,
      );
      inferred = getDefaultSubmitter(chain);
    }

    const fingerprint = getConfigFingerprint(inferred);
    // Preserve transaction execution order by only coalescing
    // adjacent transactions that share the same submitter config.
    if (batches.length > 0 && lastBatchFingerprint === fingerprint) {
      batches[batches.length - 1].transactions.push(transaction);
    } else {
      batches.push({
        config: inferred,
        transactions: [transaction],
      });
      lastBatchFingerprint = fingerprint;
    }
  }

  return batches;
}
