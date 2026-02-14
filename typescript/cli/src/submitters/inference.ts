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

export type ResolvedSubmitterBatch = {
  config: ExtendedSubmissionStrategy;
  transactions: TypedAnnotatedTransaction[];
};

function cacheKey(chain: ChainName, address: Address): string {
  return `${chain}:${normalizeAddressEvm(address)}`;
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
  const defaultSubmitter: ExtendedSubmissionStrategy['submitter'] = {
    chain,
    type: TxSubmitterType.JSON_RPC,
  };

  if (depth >= MAX_INFERENCE_DEPTH) {
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
      return {
        chain,
        type: TxSubmitterType.GNOSIS_TX_BUILDER,
        safeAddress: proposer,
        version: '1.0',
      };
    }

    const inferredIca = await inferIcaSubmitterFromAccount({
      destinationChain: chain,
      accountAddress: proposer,
      context,
      cache,
      depth: depth + 1,
    });
    if (inferredIca) {
      return inferredIca;
    }
  }

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
  if (!to || typeof to !== 'string') {
    return defaultSubmitter;
  }

  const normalizedTarget = normalizeAddressEvm(to);
  const provider = context.multiProvider.getProvider(chain);

  let ownerAddress: Address | null = null;
  try {
    ownerAddress = await Ownable__factory.connect(normalizedTarget, provider).owner();
  } catch {
    ownerAddress = null;
  }

  const inferredSubmitter = await inferSubmitterFromAddress({
    chain,
    address: ownerAddress ?? normalizedTarget,
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

function createCache(): Cache {
  return {
    safeByChainAndAddress: new Map(),
    timelockByChainAndAddress: new Map(),
    icaByChainAndAddress: new Map(),
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

  const explicitSubmissionStrategy: ExtendedSubmissionStrategy | undefined =
    strategyUrl && !isExtendedChain
      ? readChainSubmissionStrategy(strategyUrl)[chain]
      : undefined;

  if (explicitSubmissionStrategy) {
    return [
      {
        config: explicitSubmissionStrategy,
        transactions,
      },
    ];
  }

  const protocol = context.multiProvider.getProtocol(chain);
  if (protocol !== ProtocolType.Ethereum) {
    return [
      {
        config: getDefaultSubmitter(chain),
        transactions,
      },
    ];
  }

  const cache = createCache();
  const grouped = new Map<
    string,
    { config: ExtendedSubmissionStrategy; transactions: TypedAnnotatedTransaction[]; firstIndex: number }
  >();

  for (const [index, transaction] of transactions.entries()) {
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

    const key = getConfigFingerprint(inferred);
    const current = grouped.get(key);
    if (current) {
      current.transactions.push(transaction);
    } else {
      grouped.set(key, {
        config: inferred,
        transactions: [transaction],
        firstIndex: index,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ config, transactions: groupedTransactions }) => ({
      config,
      transactions: groupedTransactions,
    }));
}
