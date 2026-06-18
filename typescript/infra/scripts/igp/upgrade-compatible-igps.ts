import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';

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
  bytes32ToAddress,
  eqAddress,
  formatStandardHookMetadata,
  isEVMLike,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';
import { BigNumber, ethers } from 'ethers';

import { Contexts } from '../../config/contexts.js';
import {
  getGovernanceIcas,
  getGovernanceSafes,
  getGovernanceTimelocks,
} from '../../config/environments/mainnet3/governance/utils.js';
import { getEnvAddresses } from '../../config/registry.js';
import {
  legacyEthIcaRouter,
  legacyIcaChainRouters,
  legacyIgpChains,
} from '../../src/config/chain.js';
import { determineGovernanceType, Owner } from '../../src/governance.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import type { DeployEnvironment } from '../../src/config/deploy-environment.js';
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

type VerificationArtifact = {
  name: string;
  address: Address;
  isProxy?: boolean;
  expectedimplementation?: Address;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map((part) => parseInt(part, 10));
  const bParts = b.split('.').map((part) => parseInt(part, 10));
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart !== bPart) return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function getImplementationAddress(
  chain: ChainName,
  implementations: ChainMap<Address>,
): Address | undefined {
  return implementations[chain];
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
    rootLogger.info(
      `[${chain}] IGP does not expose PACKAGE_VERSION: ${formatError(error)}`,
    );
    return undefined;
  }
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
    ...(legacyIcaChainRouters[destination]
      ? {
          localRouter: legacyEthIcaRouter,
          routerOverride:
            legacyIcaChainRouters[destination].interchainAccountRouter,
        }
      : {}),
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
  const refundAddress = bytes32ToAddress(accountConfig.owner);
  const hookMetadata = formatStandardHookMetadata({
    gasLimit: gasLimit.toBigInt(),
    refundAddress,
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
}): Promise<string> {
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
    return `timelock operation already scheduled/done: ${operationId}`;
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

  return `timelock operation queued for scheduling: ${operationId}`;
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
}) {
  for (const group of groups) {
    let builder: EV5GnosisSafeTxBuilder;
    try {
      builder = await EV5GnosisSafeTxBuilder.create(multiProvider, {
        version: '1.0',
        chain: group.chain,
        safeAddress: group.safeAddress,
      });
    } catch (error) {
      const filepath = join(
        runDir,
        `${group.chain}-${group.governanceType}.raw.json`,
      );
      mkdirSync(dirname(filepath), { recursive: true });
      await writeAndFormatJsonAtPath(filepath, {
        chain: group.chain,
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
}

async function proposeSafeGroups({
  groups,
  multiProvider,
}: {
  groups: SafeCallGroup[];
  multiProvider: Parameters<typeof SafeMultiSend.initialize>[0];
}) {
  for (const group of groups) {
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
    rootLogger.info(
      `[${group.chain}] proposed ${group.calls.length} ${group.governanceType} tx(s): ${hashes.join(', ')}`,
    );
  }
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

  const envConfig = getEnvironmentConfig(environment);
  const chainAddresses = getEnvAddresses(environment);
  const implementationAddresses = {
    ...getImplementationAddressesFromVerificationArtifacts(
      environment,
      chainAddresses,
    ),
    ...(implementationAddressesFile
      ? readJson<ChainMap<Address>>(implementationAddressesFile)
      : {}),
  };
  const requested = chains && chains.length > 0 ? new Set(chains) : undefined;
  const targetChains = envConfig.supportedChainNames.filter((chain) => {
    if (requested && !requested.has(chain)) return false;
    if (legacyIgpChains.includes(chain)) return false;
    return true;
  });

  const multiProvider = await envConfig.getMultiProvider(
    context,
    undefined,
    true,
    targetChains,
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
    const targetImplementation = getImplementationAddress(
      chain,
      implementationAddresses,
    );
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
        targetImplementation &&
        eqAddress(currentImplementation, targetImplementation)
      ) {
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

      if (
        currentVersion &&
        compareSemver(currentVersion, CONTRACTS_PACKAGE_VERSION) >= 0
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
          detail = await routeTimelockCall({
            groups: safeGroups,
            ica,
            chain,
            governanceType,
            timelockAddress: proxyAdminOwner,
            innerCall: upgradeCall,
          });
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
  const runDir = join(
    OUTPUT_ROOT,
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  await writeSafeBatchFiles({ groups, multiProvider, runDir });

  if (propose) {
    await proposeSafeGroups({ groups, multiProvider });
  }

  const output = {
    environment,
    context,
    targetVersion: CONTRACTS_PACKAGE_VERSION,
    mode: propose ? 'propose' : 'dry-run',
    legacyIgpChains,
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
  if (plans.some((plan) => plan.status === 'error')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
