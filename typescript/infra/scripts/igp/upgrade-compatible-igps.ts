import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { pathToFileURL } from 'url';

import {
  CONTRACTS_PACKAGE_VERSION,
  Ownable__factory,
  PackageVersioned__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  EV5GnosisSafeTxBuilder,
  InterchainAccount,
  PROPOSER_ROLE,
  proxyAdmin,
  proxyImplementation,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  eqAddress,
  formatStandardHookMetadata,
  isEVMLike,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';
import { BigNumber, ethers } from 'ethers';
import { compareVersions } from 'compare-versions';

import { Contexts } from '../../config/contexts.js';
import {
  getGovernanceIcas,
  getGovernanceSafes,
} from '../../config/environments/mainnet3/governance/utils.js';
import { getEnvAddresses } from '../../config/registry.js';
import {
  chainsToSkip,
  legacyIcaChains,
  legacyIgpChains,
} from '../../src/config/chain.js';
import type { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { determineGovernanceType, Owner } from '../../src/governance.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { getEnvironmentDirectory } from '../../src/paths.js';
import { logTable } from '../../src/utils/log.js';
import { writeAndFormatJsonAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  withChains,
  withContext,
  withOutputFile,
  withPropose,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ETHEREUM_CHAIN: ChainName = 'ethereum';
const OUTPUT_ROOT = 'igp-upgrade-output';
const CANCUN_PROBE_INIT_CODE = '0x5f5f5d5f5c5f5260205ff3';

type UpgradeCall = {
  to: Address;
  data: string;
  value: BigNumber;
  description: string;
};

type ChainPlan = {
  chain: ChainName;
  interchainGasPaymaster?: Address;
  currentImplementation?: Address;
  targetImplementation?: Address;
  currentVersion?: string;
  targetVersion: string;
  proxyAdmin?: Address;
  proxyAdminOwner?: Address;
  ownerType?: Owner | null;
  governanceType?: GovernanceType;
  status: string;
  detail: string;
};

type SafeCallGroup = {
  chain: ChainName;
  governanceType: GovernanceType;
  safeAddress: Address;
  calls: UpgradeCall[];
};

type ProposalResult = {
  chain: ChainName;
  governanceType: GovernanceType;
  safeAddress: Address;
  status: 'proposed' | 'error' | 'skipped';
  detail: string;
  hashes?: string[];
};

type VerificationArtifact = {
  name: string;
  address: Address;
  isProxy?: boolean;
  expectedimplementation?: Address;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getNestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return isRecord(value[key]) ? value[key] : undefined;
}

export function isMissingPackageVersionError(error: unknown): boolean {
  if (!isRecord(error)) return false;

  const nestedError = getNestedRecord(error, 'error');
  const data = typeof error.data === 'string' ? error.data : nestedError?.data;
  if (error.code === 'CALL_EXCEPTION' && data === '0x') return true;

  return (
    error.code === 'CALL_EXCEPTION' &&
    typeof error.message === 'string' &&
    error.message.includes('data="0x"')
  );
}

function getImplementationAddressesFromVerificationArtifacts(
  environment: DeployEnvironment,
  chainAddresses: ChainMap<{ interchainGasPaymaster?: Address }>,
): ChainMap<Address> {
  const implementations: ChainMap<Address> = {};
  for (const module of ['igp', 'core']) {
    const filepath = join(
      getEnvironmentDirectory(environment),
      module,
      'verification.json',
    );
    if (!existsSync(filepath)) continue;

    const artifactsByChain =
      readJson<ChainMap<VerificationArtifact[]>>(filepath);
    for (const [chain, artifacts] of Object.entries(artifactsByChain)) {
      const interchainGasPaymaster =
        chainAddresses[chain]?.interchainGasPaymaster;
      if (!interchainGasPaymaster) continue;

      const proxyArtifact = artifacts.find(
        (artifact) =>
          artifact.isProxy &&
          artifact.expectedimplementation &&
          eqAddress(artifact.address, interchainGasPaymaster),
      );
      if (proxyArtifact?.expectedimplementation) {
        implementations[chain] = proxyArtifact.expectedimplementation;
      }
    }
  }
  return implementations;
}

export function getImplementationAddressOverrides(
  filepath: string,
  supportedChains: Set<ChainName>,
): ChainMap<Address> {
  const rawOverrides = readJson<unknown>(filepath);
  assert(isRecord(rawOverrides), `${filepath} must contain a JSON object`);

  const overrides: ChainMap<Address> = {};
  for (const [chain, value] of Object.entries(rawOverrides)) {
    assert(
      supportedChains.has(chain),
      `${filepath} contains unsupported chain ${chain}`,
    );
    assert(typeof value === 'string', `${filepath} ${chain} must be a string`);
    assert(
      ethers.utils.isAddress(value),
      `${filepath} ${chain} is not an EVM address: ${value}`,
    );
    assert(
      !eqAddress(value, ethers.constants.AddressZero),
      `${filepath} ${chain} implementation is zero address`,
    );
    overrides[chain] = value;
  }

  return overrides;
}

async function getCurrentVersion(
  chain: ChainName,
  provider: ethers.providers.Provider,
  igpAddress: Address,
): Promise<string | undefined> {
  try {
    return await PackageVersioned__factory.connect(
      igpAddress,
      provider,
    ).PACKAGE_VERSION();
  } catch (error) {
    if (!isMissingPackageVersionError(error)) throw error;
    rootLogger.info(
      `[${chain}] IGP does not expose PACKAGE_VERSION: ${formatError(error)}`,
    );
    return undefined;
  }
}

async function assertTargetImplementation({
  chain,
  provider,
  targetImplementation,
}: {
  chain: ChainName;
  provider: ethers.providers.Provider;
  targetImplementation: Address;
}): Promise<void> {
  assert(
    ethers.utils.isAddress(targetImplementation),
    `[${chain}] target implementation is not an EVM address: ${targetImplementation}`,
  );
  assert(
    !eqAddress(targetImplementation, ethers.constants.AddressZero),
    `[${chain}] target implementation is zero address`,
  );

  const code = await provider.getCode(targetImplementation);
  assert(
    code !== '0x',
    `[${chain}] target implementation ${targetImplementation} has no deployed code`,
  );

  const targetVersion = await PackageVersioned__factory.connect(
    targetImplementation,
    provider,
  ).PACKAGE_VERSION();
  assert(
    targetVersion === CONTRACTS_PACKAGE_VERSION,
    `[${chain}] target implementation ${targetImplementation} exposes PACKAGE_VERSION ${targetVersion}, expected ${CONTRACTS_PACKAGE_VERSION}`,
  );
}

async function assertCancunCompatible(
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  try {
    const result = await provider.call({ data: CANCUN_PROBE_INIT_CODE });
    assert(
      result === ethers.constants.HashZero,
      `[${chain}] Cancun probe returned unexpected data: ${result}`,
    );
  } catch (error) {
    throw new Error(
      `[${chain}] Cancun/PUSH0 preflight failed; keep this chain in legacyIgpChains or override only after manual verification`,
      { cause: error },
    );
  }
}

function timelockSalt(chain: ChainName, callData: string): string {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(
      `hyperlane-igp-upgrade:${chain}:${CONTRACTS_PACKAGE_VERSION}:${callData}`,
    ),
  );
}

function getSafeGroupKey(chain: ChainName, governanceType: GovernanceType) {
  return `${chain}:${governanceType}`;
}

export function getPostUpgradeConfigCommand({
  environment,
  context,
  chains,
}: {
  environment: string;
  context: string;
  chains: ChainName[];
}) {
  return [
    'pnpm --dir typescript/infra exec tsx scripts/deploy.ts',
    `--environment ${environment}`,
    `--context ${context}`,
    '--module igp',
    `--chains ${chains.join(' ')}`,
  ].join(' ');
}

export function getPostUpgradeConfigChains(plans: ChainPlan[]): ChainName[] {
  return plans
    .filter((plan) => plan.status === 'queued')
    .map((plan) => plan.chain);
}

function addSafeCall(
  groups: Map<string, SafeCallGroup>,
  chain: ChainName,
  governanceType: GovernanceType,
  call: UpgradeCall,
) {
  const safeAddress = getGovernanceSafes(governanceType)[chain];
  assert(
    safeAddress,
    `No ${governanceType} Safe configured on ${chain}; cannot propose ${call.description}`,
  );

  const key = getSafeGroupKey(chain, governanceType);
  const existing = groups.get(key);
  if (existing) {
    existing.calls.push(call);
    return;
  }

  groups.set(key, {
    chain,
    governanceType,
    safeAddress,
    calls: [call],
  });
}

async function addIcaSafeCall({
  groups,
  ica,
  destination,
  governanceType,
  innerCall,
  expectedRemoteOwner,
}: {
  groups: Map<string, SafeCallGroup>;
  ica: InterchainAccount;
  destination: ChainName;
  governanceType: GovernanceType;
  innerCall: UpgradeCall;
  expectedRemoteOwner?: Address;
}) {
  const safes = getGovernanceSafes(governanceType);
  const owner = safes[ETHEREUM_CHAIN];
  assert(
    owner,
    `No ${governanceType} Safe configured on ${ETHEREUM_CHAIN}; cannot propose ICA call for ${destination}`,
  );

  const accountConfig = {
    origin: ETHEREUM_CHAIN,
    owner,
  };
  const expectedIca = await ica.getAccount(destination, accountConfig);
  const ownerAddress =
    expectedRemoteOwner ??
    (await Ownable__factory.connect(
      innerCall.to,
      ica.multiProvider.getProvider(destination),
    ).owner());
  assert(
    eqAddress(expectedIca, ownerAddress),
    `[${destination}] expected ${governanceType} ICA ${expectedIca}, but ${innerCall.to} owner is ${ownerAddress}`,
  );

  const innerCalls = [
    {
      to: innerCall.to,
      data: innerCall.data,
      value: innerCall.value.toString(),
    },
  ];
  const gasLimit = await ica.estimateIcaHandleGas({
    origin: ETHEREUM_CHAIN,
    destination,
    innerCalls,
    config: accountConfig,
  });
  const hookMetadata = formatStandardHookMetadata({
    gasLimit: gasLimit.toBigInt(),
    refundAddress: accountConfig.owner,
  });
  const callRemote = await ica.getCallRemote({
    chain: ETHEREUM_CHAIN,
    destination,
    innerCalls,
    config: accountConfig,
    hookMetadata,
  });

  assert(
    callRemote.to && callRemote.data,
    `[${destination}] could not build ICA callRemote transaction`,
  );

  addSafeCall(groups, ETHEREUM_CHAIN, governanceType, {
    to: callRemote.to,
    data: callRemote.data,
    value: callRemote.value ?? BigNumber.from(0),
    description: `ICA ${destination}: ${innerCall.description}`,
  });
}

async function routeTimelockCall({
  groups,
  ica,
  chain,
  governanceType,
  timelockAddress,
  innerCall,
}: {
  groups: Map<string, SafeCallGroup>;
  ica: InterchainAccount;
  chain: ChainName;
  governanceType: GovernanceType;
  timelockAddress: Address;
  innerCall: UpgradeCall;
}): Promise<{ status: 'queued' | 'scheduled'; detail: string }> {
  const provider = ica.multiProvider.getProvider(chain);
  const timelock = TimelockController__factory.connect(
    timelockAddress,
    provider,
  );
  const delay = await timelock.getMinDelay();
  const salt = timelockSalt(chain, innerCall.data);
  const predecessor = ethers.constants.HashZero;
  const targets = [innerCall.to];
  const values = [innerCall.value];
  const payloads = [innerCall.data];
  const operationId = await timelock.hashOperationBatch(
    targets,
    values,
    payloads,
    predecessor,
    salt,
  );

  const isScheduled =
    (await timelock.isOperationPending(operationId)) ||
    (await timelock.isOperationReady(operationId)) ||
    (await timelock.isOperationDone(operationId));
  if (isScheduled) {
    return {
      status: 'scheduled',
      detail: `timelock operation already scheduled/done: ${operationId}`,
    };
  }

  const scheduleCall: UpgradeCall = {
    to: timelockAddress,
    data: timelock.interface.encodeFunctionData('scheduleBatch', [
      targets,
      values,
      payloads,
      predecessor,
      salt,
      delay,
    ]),
    value: BigNumber.from(0),
    description: `Schedule timelock operation ${operationId}: ${innerCall.description}`,
  };

  const proposer =
    chain === ETHEREUM_CHAIN
      ? getGovernanceSafes(governanceType)[ETHEREUM_CHAIN]
      : getGovernanceIcaAddress(chain, governanceType);
  assert(
    proposer,
    `[${chain}] no ${governanceType} proposer address available for timelock ${timelockAddress}`,
  );
  assert(
    await timelock.hasRole(PROPOSER_ROLE, proposer),
    `[${chain}] ${proposer} does not have PROPOSER_ROLE on timelock ${timelockAddress}`,
  );

  if (chain === ETHEREUM_CHAIN) {
    addSafeCall(groups, ETHEREUM_CHAIN, governanceType, scheduleCall);
  } else {
    await addIcaSafeCall({
      groups,
      ica,
      destination: chain,
      governanceType,
      innerCall: scheduleCall,
      expectedRemoteOwner: proposer,
    });
  }

  return {
    status: 'queued',
    detail: `timelock operation queued for scheduling: ${operationId}`,
  };
}

function getGovernanceIcaAddress(
  chain: ChainName,
  governanceType: GovernanceType,
): Address | undefined {
  return getGovernanceIcas(governanceType)[chain];
}

async function writeSafeBatchFiles({
  groups,
  multiProvider,
  runDir,
}: {
  groups: SafeCallGroup[];
  multiProvider: Parameters<typeof EV5GnosisSafeTxBuilder.create>[0];
  runDir: string;
}): Promise<Set<string>> {
  const rawFallbackGroupKeys = new Set<string>();
  for (const group of groups) {
    let builder: EV5GnosisSafeTxBuilder;
    try {
      builder = await EV5GnosisSafeTxBuilder.create(multiProvider, {
        version: '1.0',
        chain: group.chain,
        safeAddress: group.safeAddress,
      });
    } catch (error) {
      rawFallbackGroupKeys.add(
        getSafeGroupKey(group.chain, group.governanceType),
      );
      const filepath = join(
        runDir,
        `${group.chain}-${group.governanceType}.raw.json`,
      );
      mkdirSync(dirname(filepath), { recursive: true });
      await writeAndFormatJsonAtPath(filepath, {
        chain: group.chain,
        chainId: multiProvider.getEvmChainId(group.chain),
        safeAddress: group.safeAddress,
        governanceType: group.governanceType,
        note: 'Raw calldata. NOT a Safe Transaction Builder file (no usable tx service for this chain); submit manually.',
        error: formatError(error),
        transactions: group.calls.map((call) => ({
          to: call.to,
          value: call.value.toString(),
          data: call.data,
          description: call.description,
        })),
      });
      rootLogger.warn(
        `[${group.chain}] wrote raw ${group.governanceType} payload ${basename(filepath)}`,
      );
      continue;
    }

    const chainId = multiProvider.getEvmChainId(group.chain);
    const txs: AnnotatedEV5Transaction[] = group.calls.map((call) => ({
      to: call.to,
      data: call.data,
      value: call.value,
      chainId,
    }));
    const batch = await builder.submit(...txs);
    const filepath = join(
      runDir,
      `${group.chain}-${group.governanceType}.json`,
    );
    mkdirSync(dirname(filepath), { recursive: true });
    await writeAndFormatJsonAtPath(filepath, batch);
    rootLogger.info(
      `[${group.chain}] wrote ${group.governanceType} Safe batch ${filepath}`,
    );
  }
  return rawFallbackGroupKeys;
}

async function proposeSafeGroups({
  groups,
  multiProvider,
}: {
  groups: SafeCallGroup[];
  multiProvider: Parameters<typeof SafeMultiSend.initialize>[0];
}): Promise<ProposalResult[]> {
  const results: ProposalResult[] = [];
  for (const group of groups) {
    try {
      const safeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        group.chain,
        group.safeAddress,
      );
      const hashes = await safeMultiSend.sendTransactions(
        group.calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: call.value,
        })),
      );
      results.push({
        chain: group.chain,
        governanceType: group.governanceType,
        safeAddress: group.safeAddress,
        status: 'proposed',
        detail: `proposed ${group.calls.length} tx(s)`,
        hashes,
      });
      rootLogger.info(
        `[${group.chain}] proposed ${group.calls.length} ${group.governanceType} tx(s): ${hashes.join(', ')}`,
      );
    } catch (error) {
      const detail = formatError(error);
      results.push({
        chain: group.chain,
        governanceType: group.governanceType,
        safeAddress: group.safeAddress,
        status: 'error',
        detail,
      });
      rootLogger.error(
        `[${group.chain}] failed to propose ${group.governanceType} Safe tx(s): ${detail}`,
      );
    }
  }
  return results;
}

export function splitProposableGroups({
  groups,
  rawFallbackGroupKeys,
}: {
  groups: SafeCallGroup[];
  rawFallbackGroupKeys: Set<string>;
}): {
  proposableGroups: SafeCallGroup[];
  skippedProposalResults: ProposalResult[];
} {
  const proposableGroups: SafeCallGroup[] = [];
  const skippedProposalResults: ProposalResult[] = [];

  for (const group of groups) {
    if (
      !rawFallbackGroupKeys.has(
        getSafeGroupKey(group.chain, group.governanceType),
      )
    ) {
      proposableGroups.push(group);
      continue;
    }

    skippedProposalResults.push({
      chain: group.chain,
      governanceType: group.governanceType,
      safeAddress: group.safeAddress,
      status: 'skipped',
      detail:
        'skipped propose because only raw fallback calldata was written; submit manually',
    });
  }

  return { proposableGroups, skippedProposalResults };
}

async function main() {
  const {
    environment,
    context = Contexts.Hyperlane,
    chains,
    outFile,
    propose,
    all,
    implementationAddressesFile,
    skipEvmPreflight,
  } = await withOutputFile(
    withChains(
      withContext(
        withPropose(
          getArgs()
            .option('implementationAddressesFile', {
              type: 'string',
              describe:
                'Optional JSON map of chain name to already deployed InterchainGasPaymaster implementation address. Overrides verification artifacts.',
            })
            .option('all', {
              type: 'boolean',
              default: false,
              describe:
                'Confirm proposing for every compatible chain when --chains is omitted',
            })
            .option('skipEvmPreflight', {
              type: 'boolean',
              default: false,
              describe: 'Skip Cancun/PUSH0 eth_call preflight',
            }),
        ),
      ),
    ),
  ).argv;

  assert(
    !propose || chains?.length || all,
    'Refusing to propose for all compatible chains without --all. Pass --chains or --all.',
  );
  assert(
    environment === 'mainnet3',
    'This script only supports mainnet3 because governance Safe, ICA, and timelock config is imported from mainnet3.',
  );

  const envConfig = getEnvironmentConfig(environment);
  const supportedChains = new Set(envConfig.supportedChainNames);
  const chainAddresses = getEnvAddresses(environment);
  const implementationAddresses = {
    ...getImplementationAddressesFromVerificationArtifacts(
      environment,
      chainAddresses,
    ),
    ...(implementationAddressesFile
      ? getImplementationAddressOverrides(
          implementationAddressesFile,
          supportedChains,
        )
      : {}),
  };
  const requested = chains && chains.length > 0 ? new Set(chains) : undefined;

  if (requested) {
    for (const chain of requested) {
      if (!supportedChains.has(chain)) {
        rootLogger.warn(
          `[${chain}] requested but not supported in ${environment}; skipping`,
        );
      } else if (legacyIgpChains.includes(chain)) {
        rootLogger.warn(
          `[${chain}] requested but in legacyIgpChains; skipping`,
        );
      } else if (chainsToSkip.includes(chain)) {
        rootLogger.warn(`[${chain}] requested but in chainsToSkip; skipping`);
      }
    }
  }

  const targetChains = envConfig.supportedChainNames.filter((chain) => {
    if (requested && !requested.has(chain)) return false;
    if (legacyIgpChains.includes(chain)) return false;
    if (chainsToSkip.includes(chain)) return false;
    return true;
  });
  const providerChains = Array.from(new Set([...targetChains, ETHEREUM_CHAIN]));

  const multiProvider = await envConfig.getMultiProvider(
    context,
    undefined,
    true,
    providerChains,
  );
  const icaAddresses = Object.fromEntries(
    Object.entries(chainAddresses).filter(
      ([, addresses]) => !!addresses.interchainAccountRouter,
    ),
  );
  const ica = InterchainAccount.fromAddressesMap(icaAddresses, multiProvider);
  const safeGroups = new Map<string, SafeCallGroup>();
  const plans: ChainPlan[] = [];

  for (const chain of targetChains) {
    const metadata = multiProvider.getChainMetadata(chain);
    if (!isEVMLike(metadata.protocol)) {
      plans.push({
        chain,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        status: 'skipped',
        detail: `non-EVM protocol ${metadata.protocol}`,
      });
      continue;
    }

    const addresses = chainAddresses[chain];
    const interchainGasPaymaster = addresses?.interchainGasPaymaster;
    if (!interchainGasPaymaster) {
      plans.push({
        chain,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        status: 'skipped',
        detail: 'missing interchainGasPaymaster in registry',
      });
      continue;
    }

    const provider = multiProvider.getProvider(chain);
    const targetImplementation = implementationAddresses[chain];
    try {
      if (!skipEvmPreflight) {
        await assertCancunCompatible(chain, provider);
      }

      const currentImplementation = await proxyImplementation(
        provider,
        interchainGasPaymaster,
      );
      const currentVersion = await getCurrentVersion(
        chain,
        provider,
        interchainGasPaymaster,
      );
      const actualProxyAdmin = await proxyAdmin(
        provider,
        interchainGasPaymaster,
      );
      if (
        currentVersion &&
        compareVersions(currentVersion, CONTRACTS_PACKAGE_VERSION) >= 0
      ) {
        plans.push({
          chain,
          interchainGasPaymaster,
          currentImplementation,
          targetImplementation,
          currentVersion,
          targetVersion: CONTRACTS_PACKAGE_VERSION,
          proxyAdmin: actualProxyAdmin,
          status: 'skipped',
          detail: 'current contract version is already >= target version',
        });
        continue;
      }

      if (!targetImplementation) {
        plans.push({
          chain,
          interchainGasPaymaster,
          currentImplementation,
          currentVersion,
          targetVersion: CONTRACTS_PACKAGE_VERSION,
          proxyAdmin: actualProxyAdmin,
          status: 'error',
          detail: 'missing implementation address',
        });
        continue;
      }

      await assertTargetImplementation({
        chain,
        provider,
        targetImplementation,
      });

      if (eqAddress(currentImplementation, targetImplementation)) {
        plans.push({
          chain,
          interchainGasPaymaster,
          currentImplementation,
          targetImplementation,
          currentVersion,
          targetVersion: CONTRACTS_PACKAGE_VERSION,
          proxyAdmin: actualProxyAdmin,
          status: 'no change',
          detail: 'proxy already points at target implementation',
        });
        continue;
      }

      const proxyAdminOwner = await Ownable__factory.connect(
        actualProxyAdmin,
        provider,
      ).owner();
      const { ownerType, governanceType } = await determineGovernanceType(
        chain,
        proxyAdminOwner,
      );
      const upgradeCall: UpgradeCall = {
        to: actualProxyAdmin,
        data: ProxyAdmin__factory.createInterface().encodeFunctionData(
          'upgrade',
          [interchainGasPaymaster, targetImplementation],
        ),
        value: BigNumber.from(0),
        description: `Upgrade IGP ${interchainGasPaymaster} to ${CONTRACTS_PACKAGE_VERSION} implementation ${targetImplementation}`,
      };

      let detail: string;
      switch (ownerType) {
        case Owner.SAFE:
          addSafeCall(safeGroups, chain, governanceType, upgradeCall);
          detail = `queued ${governanceType} Safe proposal`;
          break;
        case Owner.ICA:
          if (legacyIcaChains.includes(chain)) {
            plans.push({
              chain,
              interchainGasPaymaster,
              currentImplementation,
              targetImplementation,
              currentVersion,
              targetVersion: CONTRACTS_PACKAGE_VERSION,
              proxyAdmin: actualProxyAdmin,
              proxyAdminOwner,
              ownerType,
              governanceType,
              status: 'manual',
              detail:
                'ProxyAdmin is owned by a legacy V1 ICA; script only builds V2 ICA calls',
            });
            continue;
          }
          await addIcaSafeCall({
            groups: safeGroups,
            ica,
            destination: chain,
            governanceType,
            innerCall: upgradeCall,
          });
          detail = `queued ${governanceType} ICA proposal from ethereum`;
          break;
        case Owner.TIMELOCK:
          const timelockRoute = await routeTimelockCall({
            groups: safeGroups,
            ica,
            chain,
            governanceType,
            timelockAddress: proxyAdminOwner,
            innerCall: upgradeCall,
          });
          if (timelockRoute.status === 'scheduled') {
            plans.push({
              chain,
              interchainGasPaymaster,
              currentImplementation,
              targetImplementation,
              currentVersion,
              targetVersion: CONTRACTS_PACKAGE_VERSION,
              proxyAdmin: actualProxyAdmin,
              proxyAdminOwner,
              ownerType,
              governanceType,
              status: 'scheduled',
              detail: timelockRoute.detail,
            });
            continue;
          }
          detail = timelockRoute.detail;
          break;
        case Owner.DEPLOYER:
          plans.push({
            chain,
            interchainGasPaymaster,
            currentImplementation,
            targetImplementation,
            currentVersion,
            targetVersion: CONTRACTS_PACKAGE_VERSION,
            proxyAdmin: actualProxyAdmin,
            proxyAdminOwner,
            ownerType,
            governanceType,
            status: 'manual',
            detail:
              'ProxyAdmin is deployer-owned; script does not execute deployer-key upgrades',
          });
          continue;
        default:
          plans.push({
            chain,
            interchainGasPaymaster,
            currentImplementation,
            targetImplementation,
            currentVersion,
            targetVersion: CONTRACTS_PACKAGE_VERSION,
            proxyAdmin: actualProxyAdmin,
            proxyAdminOwner,
            ownerType,
            governanceType,
            status: 'manual',
            detail: `unknown ProxyAdmin owner ${proxyAdminOwner}`,
          });
          continue;
      }

      plans.push({
        chain,
        interchainGasPaymaster,
        currentImplementation,
        targetImplementation,
        currentVersion,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        proxyAdmin: actualProxyAdmin,
        proxyAdminOwner,
        ownerType,
        governanceType,
        status: 'queued',
        detail,
      });
    } catch (error) {
      plans.push({
        chain,
        interchainGasPaymaster,
        targetImplementation,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        status: 'error',
        detail: formatError(error),
      });
    }
  }

  const groups = [...safeGroups.values()];
  const queuedUpgradeChains = getPostUpgradeConfigChains(plans);
  const postUpgradeConfigCommand =
    queuedUpgradeChains.length > 0
      ? getPostUpgradeConfigCommand({
          environment,
          context,
          chains: queuedUpgradeChains,
        })
      : undefined;
  const runDir = join(
    OUTPUT_ROOT,
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  const rawFallbackGroupKeys = await writeSafeBatchFiles({
    groups,
    multiProvider,
    runDir,
  });

  const proposalResults: ProposalResult[] = [];
  if (propose) {
    const { proposableGroups, skippedProposalResults } = splitProposableGroups({
      groups,
      rawFallbackGroupKeys,
    });
    proposalResults.push(...skippedProposalResults);
    for (const result of skippedProposalResults) {
      rootLogger.warn(`[${result.chain}] ${result.detail}`);
    }

    proposalResults.push(
      ...(await proposeSafeGroups({
        groups: proposableGroups,
        multiProvider,
      })),
    );
  }

  const output = {
    environment,
    context,
    targetVersion: CONTRACTS_PACKAGE_VERSION,
    mode: propose ? 'propose' : 'dry-run',
    legacyIgpChains,
    ...(postUpgradeConfigCommand ? { postUpgradeConfigCommand } : {}),
    ...(proposalResults.length > 0 ? { proposalResults } : {}),
    safeGroups: groups.map((group) => ({
      chain: group.chain,
      governanceType: group.governanceType,
      safeAddress: group.safeAddress,
      transactionCount: group.calls.length,
    })),
    plans,
  };

  if (outFile) {
    await writeAndFormatJsonAtPath(outFile, output);
  }
  logTable(plans, ['chain', 'status', 'ownerType', 'governanceType', 'detail']);

  if (!propose) {
    rootLogger.info(`Dry run: Safe batch files written under ${runDir}`);
  }
  if (postUpgradeConfigCommand) {
    rootLogger.warn(
      [
        'After the upgrade transactions execute and any ICA messages relay, immediately apply IGP config.',
        'The upgraded IGP reads native gas params from new storage slots; until config is applied, native gas payments may be underquoted or zero.',
        postUpgradeConfigCommand,
      ].join('\n'),
    );
  }
  if (
    plans.some((plan) => plan.status === 'error') ||
    proposalResults.some((result) => result.status === 'error')
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    rootLogger.error(error);
    process.exit(1);
  });
}
