import { constants as ethersConstants } from 'ethers';

import {
  ISafe__factory,
  InterchainAccountRouter__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  type Address,
  type ChainName,
  type TypedAnnotatedTransaction,
  PROPOSER_ROLE,
  TxSubmitterType,
  bytes32ToAddress,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  eqAddress,
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

type Cache = {
  safeByChainAndAddress: Map<string, boolean>;
  timelockByChainAndAddress: Map<string, boolean>;
  icaByChainAndAddress: Map<string, ExtendedSubmissionStrategy['submitter']>;
  timelockProposerByChainAndAddress: Map<
    string,
    ExtendedSubmissionStrategy['submitter']
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
  return normalizeAddressEvm(normalizedPrefix);
}

function cacheKey(chain: ChainName, address: Address): string {
  return `${chain}:${normalizeEvmAddressFlexible(address)}`;
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

  try {
    const provider = context.multiProvider.getProvider(chain);
    const safe = ISafe__factory.connect(address, provider);
    await Promise.all([safe.getThreshold(), safe.nonce()]);
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

  try {
    const provider = context.multiProvider.getProvider(chain);
    const timelock = TimelockController__factory.connect(address, provider);
    await timelock.getMinDelay();
    cache.timelockByChainAndAddress.set(key, true);
    return true;
  } catch {
    cache.timelockByChainAndAddress.set(key, false);
    return false;
  }
}

async function inferIcaSubmitterFromAccount({
  destinationChain,
  accountAddress,
  context,
  cache,
  depth,
}: InferIcaParams): Promise<ExtendedSubmissionStrategy['submitter'] | null> {
  if (depth >= MAX_INFERENCE_DEPTH) {
    return null;
  }

  const cacheId = cacheKey(destinationChain, accountAddress);
  const cached = cache.icaByChainAndAddress.get(cacheId);
  if (cached) {
    return cached;
  }

  const registryAddresses = await context.registry.getAddresses();
  const destinationAddresses = registryAddresses[destinationChain];
  const destinationRouterAddress = destinationAddresses?.interchainAccountRouter;
  if (!destinationRouterAddress) {
    return null;
  }

  const provider = context.multiProvider.getProvider(destinationChain);
  const destinationRouter = InterchainAccountRouter__factory.connect(
    destinationRouterAddress,
    provider,
  );

  const eventFilter = destinationRouter.filters.InterchainAccountCreated(
    accountAddress,
  );
  const logs = await provider.getLogs({
    ...eventFilter,
    fromBlock: 0,
    toBlock: 'latest',
  });

  const lastLog = logs[logs.length - 1];
  if (!lastLog) {
    // Fall back to deriving the ICA from signer owner and known routers,
    // to support routes where the ICA has not been deployed yet.
    const signerAddress =
      await context.multiProvider.getSignerAddress(destinationChain);
    const signerCandidates = [signerAddress];

    for (const ownerCandidate of signerCandidates) {
      for (const [originChain, originAddresses] of Object.entries(
        registryAddresses,
      )) {
        if (originChain === destinationChain) {
          continue;
        }

        if (
          context.multiProvider.getProtocol(originChain) !==
          ProtocolType.Ethereum
        ) {
          continue;
        }

        const originRouterAddress = originAddresses?.interchainAccountRouter;
        if (!originRouterAddress) {
          continue;
        }

        try {
          const originRouter = InterchainAccountRouter__factory.connect(
            originRouterAddress,
            context.multiProvider.getProvider(originChain),
          );
          const derivedAccount = await originRouter[
            'getRemoteInterchainAccount(address,address,address)'
          ](ownerCandidate, destinationRouterAddress, ethersConstants.AddressZero);

          if (!eqAddress(derivedAccount, accountAddress)) {
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
            originInterchainAccountRouter: originRouterAddress,
            destinationInterchainAccountRouter: destinationRouterAddress,
          };

          cache.icaByChainAndAddress.set(cacheId, submitter);
          return submitter;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  const parsed = destinationRouter.interface.parseLog(lastLog);
  const originDomain = Number(parsed.args.origin);
  const originRouter = bytes32ToAddress(parsed.args.router);
  const owner = bytes32ToAddress(parsed.args.owner);
  const ism = parsed.args.ism as Address;

  let originChain: ChainName;
  try {
    originChain = context.multiProvider.getChainName(originDomain);
  } catch {
    return null;
  }

  const internalSubmitter = await inferSubmitterFromAddress({
    chain: originChain,
    address: owner,
    context,
    cache,
    depth: depth + 1,
  });

  const submitter = {
    type: TxSubmitterType.INTERCHAIN_ACCOUNT,
    chain: originChain,
    destinationChain,
    owner,
    internalSubmitter,
    originInterchainAccountRouter: originRouter,
    destinationInterchainAccountRouter: destinationRouterAddress,
    ...(eqAddress(ism, ethersConstants.AddressZero)
      ? {}
      : { interchainSecurityModule: ism }),
  };

  cache.icaByChainAndAddress.set(cacheId, submitter);
  return submitter;
}

async function inferTimelockProposerSubmitter({
  chain,
  timelockAddress,
  context,
  cache,
  depth,
}: InferTimelockProposerParams): Promise<ExtendedSubmissionStrategy['submitter']> {
  const timelockKey = cacheKey(chain, timelockAddress);
  const cached = cache.timelockProposerByChainAndAddress.get(timelockKey);
  if (cached) {
    return cached;
  }

  const defaultSubmitter: ExtendedSubmissionStrategy['submitter'] = {
    chain,
    type: TxSubmitterType.JSON_RPC,
  };

  if (depth >= MAX_INFERENCE_DEPTH) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  const signerAddress = await context.multiProvider.getSignerAddress(chain);
  const provider = context.multiProvider.getProvider(chain);
  const timelock = TimelockController__factory.connect(timelockAddress, provider);

  const [isOpenProposerRole, signerHasRole] = await Promise.all([
    timelock.hasRole(PROPOSER_ROLE, ethersConstants.AddressZero),
    timelock.hasRole(PROPOSER_ROLE, signerAddress),
  ]);

  if (isOpenProposerRole || signerHasRole) {
    cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
    return defaultSubmitter;
  }

  const roleGrantedTopic = timelock.interface.getEventTopic('RoleGranted');
  const roleRevokedTopic = timelock.interface.getEventTopic('RoleRevoked');

  const [grantedLogs, revokedLogs] = await Promise.all([
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

  const granted = new Set<Address>();
  for (const log of grantedLogs) {
    const parsed = timelock.interface.parseLog(log);
    granted.add(parsed.args.account as Address);
  }
  for (const log of revokedLogs) {
    const parsed = timelock.interface.parseLog(log);
    granted.delete(parsed.args.account as Address);
  }

  const proposers = Array.from(granted).filter(
    (account) => !eqAddress(account, ethersConstants.AddressZero),
  );

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
      };
      cache.timelockProposerByChainAndAddress.set(
        timelockKey,
        proposerSubmitter,
      );
      return proposerSubmitter;
    }

    const inferredIca = await inferIcaSubmitterFromAccount({
      destinationChain: chain,
      accountAddress: proposer,
      context,
      cache,
      depth: depth + 1,
    });
    if (inferredIca) {
      cache.timelockProposerByChainAndAddress.set(timelockKey, inferredIca);
      return inferredIca;
    }
  }

  cache.timelockProposerByChainAndAddress.set(timelockKey, defaultSubmitter);
  return defaultSubmitter;
}

async function inferSubmitterFromAddress({
  chain,
  address,
  context,
  cache,
  depth,
}: InferSubmitterFromAddressParams): Promise<ExtendedSubmissionStrategy['submitter']> {
  const defaultSubmitter: ExtendedSubmissionStrategy['submitter'] = {
    chain,
    type: TxSubmitterType.JSON_RPC,
  };

  if (depth >= MAX_INFERENCE_DEPTH) {
    return defaultSubmitter;
  }

  const signerAddress = await context.multiProvider.getSignerAddress(chain);
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
    };
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
    };
  }

  const inferredIca = await inferIcaSubmitterFromAccount({
    destinationChain: chain,
    accountAddress: address,
    context,
    cache,
    depth: depth + 1,
  });
  if (inferredIca) {
    return inferredIca;
  }

  return defaultSubmitter;
}

async function inferSubmitterFromTransaction({
  chain,
  transaction,
  context,
  cache,
}: {
  chain: ChainName;
  transaction: TypedAnnotatedTransaction;
  context: WriteCommandContext;
  cache: Cache;
}): Promise<ExtendedSubmissionStrategy> {
  const defaultSubmitter = getDefaultSubmitter(chain);

  if (context.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
    return defaultSubmitter;
  }

  const to = (transaction as any).to;
  const from = (transaction as any).from;
  if (!to || typeof to !== 'string') {
    return defaultSubmitter;
  }

  const normalizedTarget = normalizeEvmAddressFlexible(to);
  const provider = context.multiProvider.getProvider(chain);

  let ownerAddress: Address | null = null;
  try {
    ownerAddress = await Ownable__factory.connect(normalizedTarget, provider).owner();
  } catch {
    ownerAddress = null;
  }

  const addressToInferFrom =
    ownerAddress ??
    (typeof from === 'string'
      ? normalizeEvmAddressFlexible(from)
      : normalizedTarget);

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
  return JSON.stringify(config.submitter);
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
      const normalizedTarget = tryNormalizeEvmAddress(parsed.target);
      if (!normalizedTarget) {
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
  const entries = Object.entries(overrides);
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

function createCache(): Cache {
  return {
    safeByChainAndAddress: new Map(),
    timelockByChainAndAddress: new Map(),
    icaByChainAndAddress: new Map(),
    timelockProposerByChainAndAddress: new Map(),
  };
}

export async function resolveSubmitterBatchesForTransactions({
  chain,
  transactions,
  context,
  strategyUrl,
  isExtendedChain,
}: ResolveSubmitterBatchesParams): Promise<ResolvedSubmitterBatch[]> {
  assert(transactions.length > 0, `No transactions provided for chain ${chain}`);
  const protocol = context.multiProvider.getProtocol(chain);

  const explicitSubmissionStrategy: ExtendedSubmissionStrategy | undefined =
    strategyUrl && !isExtendedChain
      ? readChainSubmissionStrategy(strategyUrl)[chain]
      : undefined;

  if (explicitSubmissionStrategy) {
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
