import { constants as ethersConstants } from 'ethers';

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

function compareLogsByPosition(
  a: { blockNumber?: number; transactionIndex?: number; logIndex?: number },
  b: { blockNumber?: number; transactionIndex?: number; logIndex?: number },
): number {
  const blockDiff = (a.blockNumber ?? -1) - (b.blockNumber ?? -1);
  if (blockDiff !== 0) {
    return blockDiff;
  }

  const txIndexDiff = (a.transactionIndex ?? -1) - (b.transactionIndex ?? -1);
  if (txIndexDiff !== 0) {
    return txIndexDiff;
  }

  return (a.logIndex ?? -1) - (b.logIndex ?? -1);
}

async function hasSignerForChain(
  context: WriteCommandContext,
  cache: Cache,
  chain: ChainName,
): Promise<boolean> {
  const cached = cache.signerByChain.get(chain);
  if (cached !== undefined) {
    return cached;
  }

  const maybeTryGetSigner = (context.multiProvider as any).tryGetSigner;
  if (typeof maybeTryGetSigner !== 'function') {
    const signerAddress = await getSignerAddressForChain(context, cache, chain);
    const hasSigner = !!signerAddress;
    cache.signerByChain.set(chain, hasSigner);
    return hasSigner;
  }
  try {
    const hasSigner = !!maybeTryGetSigner.call(context.multiProvider, chain);
    cache.signerByChain.set(chain, hasSigner);
    return hasSigner;
  } catch {
    cache.signerByChain.set(chain, false);
    return false;
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
): Promise<Awaited<ReturnType<WriteCommandContext['registry']['getAddresses']>>> {
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
    cache.signerAddressByChain.set(chain, signerAddress);
    return signerAddress;
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
    const ownerAddress = await Ownable__factory.connect(target, provider).owner();
    const normalizedOwner = tryNormalizeEvmAddress(ownerAddress);
    cache.ownerByChainAndAddress.set(ownerKey, normalizedOwner);
    return normalizedOwner;
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
  const destinationRouterAddress = destinationAddresses?.interchainAccountRouter;
  if (!destinationRouterAddress) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }
  const normalizedDestinationRouterAddress = tryNormalizeEvmAddress(
    destinationRouterAddress,
  );
  if (!normalizedDestinationRouterAddress) {
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

  const eventFilter = destinationRouter.filters.InterchainAccountCreated(
    accountAddress,
  );
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

  const lastLog = [...logs].sort(compareLogsByPosition).at(-1);
  if (!lastLog) {
    // Fall back to deriving the ICA from signer owner and known routers,
    // to support routes where the ICA has not been deployed yet.
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
        if (!normalizedOriginRouterAddress) {
          continue;
        }

        try {
          if (!(await hasSignerForChain(context, cache, originChain))) {
            continue;
          }
          const originProvider = getProviderForChain(context, cache, originChain);
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
            ethersConstants.AddressZero,
          );

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
            originInterchainAccountRouter: normalizedOriginRouterAddress,
            destinationInterchainAccountRouter: normalizedDestinationRouterAddress,
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

  let originDomain: number;
  let originRouter: Address;
  let owner: Address;
  let ism: Address;
  try {
    const parsed = destinationRouter.interface.parseLog(lastLog);
    originDomain = Number(parsed.args.origin);
    originRouter = bytes32ToAddress(parsed.args.router);
    owner = bytes32ToAddress(parsed.args.owner);
    ism = parsed.args.ism as Address;
  } catch {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }

  const originChain = getChainNameForDomain(context, cache, originDomain);
  if (!originChain) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }

  if (!(await hasSignerForChain(context, cache, originChain))) {
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
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
    cache.icaByChainAndAddress.set(cacheId, null);
    return null;
  }

  const submitter = {
    type: TxSubmitterType.INTERCHAIN_ACCOUNT,
    chain: originChain,
    destinationChain,
    owner,
    internalSubmitter,
    originInterchainAccountRouter: originRouter,
    destinationInterchainAccountRouter: normalizedDestinationRouterAddress,
    ...(eqAddress(ism, ethersConstants.AddressZero)
      ? {}
      : { interchainSecurityModule: ism }),
  } satisfies Extract<
    InferredSubmitter,
    { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
  >;

  cache.icaByChainAndAddress.set(cacheId, submitter);
  return submitter;
}

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
  const timelock = TimelockController__factory.connect(timelockAddress, provider);

  let isOpenProposerRole = false;
  let signerHasRole = false;
  try {
    [isOpenProposerRole, signerHasRole] = await Promise.all([
      timelock.hasRole(PROPOSER_ROLE, ethersConstants.AddressZero),
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
      if (normalizedAccount) {
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
    (account) => !eqAddress(account, ethersConstants.AddressZero),
  );
  const registryAddresses = await getRegistryAddresses(context, cache);
  const destinationRouterAddress = tryNormalizeEvmAddress(
    registryAddresses[chain]?.interchainAccountRouter ?? '',
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
        if (!normalizedOriginRouterAddress) {
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
          ](
            signerAddress,
            destinationRouterAddress,
            ethersConstants.AddressZero,
          );

          if (!eqAddress(derivedIcaProposer, proposer)) {
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
      if (!normalizedOriginRouterAddress) {
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
        ](signerAddress, destinationRouterAddress, ethersConstants.AddressZero);

        if (!(await timelock.hasRole(PROPOSER_ROLE, derivedIcaProposer))) {
          continue;
        }

        const inferredIca = await inferIcaSubmitterFromAccount({
          destinationChain: chain,
          accountAddress: derivedIcaProposer,
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
  let protocol: ProtocolType | undefined;
  try {
    protocol = context.multiProvider.getProtocol(chain);
  } catch (error) {
    logger.debug(
      `Falling back to default protocol handling for ${chain}`,
      error,
    );
    protocol = undefined;
  }

  const explicitSubmissionStrategy: ExtendedSubmissionStrategy | undefined =
    strategyUrl && !isExtendedChain
      ? readChainSubmissionStrategy(strategyUrl)[chain]
      : undefined;

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
