import { mkdirSync } from 'fs';
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
  ChainNameOrId,
  EV5GnosisSafeTxBuilder,
  EvmHookModule,
  HookType,
  IgpConfig,
  InterchainAccount,
  MultiProvider,
  PROPOSER_ROLE,
  extractIsmAndHookFactoryAddresses,
  proxyAdmin,
  proxyImplementation,
} from '@hyperlane-xyz/sdk';
import {
  isMissingSelectorCallException,
  isValidContractVersion,
} from '@hyperlane-xyz/sdk/utils/contract';
import {
  Address,
  assert,
  deepCopy,
  eqAddress,
  formatStandardHookMetadata,
  isEVMLike,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { BigNumber, ethers } from 'ethers';

import { Contexts } from '../../config/contexts.js';
import {
  getGovernanceIcas,
  getGovernanceSafes,
  getLegacyGovernanceIcas,
} from '../../config/environments/mainnet3/governance/utils.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { getEnvAddresses } from '../../config/registry.js';
import { chainsToSkip, legacyIgpChains } from '../../src/config/chain.js';
import { determineGovernanceType, Owner } from '../../src/governance.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { GOVERNOR_MAX_BATCH_SIZE } from '../../src/govern/HyperlaneAppGovernor.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { Role } from '../../src/roles.js';
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
const TIMELOCK_LOOKBACK_BLOCKS = 2_000_000;
const TIMELOCK_LOG_CHUNK_BLOCKS = 50_000;

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
  transactionCount?: number;
  simulatedDeployments?: SimulatedDeployment[];
  status: string;
  detail: string;
};

type SafeCallGroup = {
  chain: ChainName;
  governanceType: GovernanceType;
  safeAddress: Address;
  calls: UpgradeCall[];
  batchIndex?: number;
  batchCount?: number;
};

type ProposalResult = {
  chain: ChainName;
  governanceType: GovernanceType;
  safeAddress: Address;
  status: 'proposed' | 'error' | 'skipped';
  detail: string;
  hashes?: string[];
};

type SimulatedDeployment = {
  chain: ChainName;
  contractName: string;
  address: Address;
  nonce: number;
};

class DryRunDeployMultiProvider extends MultiProvider {
  readonly simulatedDeployments: SimulatedDeployment[] = [];
  private readonly nextNonces: ChainMap<number> = {};

  constructor(
    base: MultiProvider,
    private readonly deployerAddress: Address,
  ) {
    super(base.metadata, {
      ...base.options,
      providers: base.providers,
      signers: base.signers,
    });
  }

  override async getSignerAddress(_chainNameOrId: ChainNameOrId) {
    return this.deployerAddress;
  }

  override async handleDeploy<
    F extends Parameters<MultiProvider['handleDeploy']>[1],
  >(
    chainNameOrId: ChainNameOrId,
    factory: F,
    params: Parameters<F['deploy']>,
  ): Promise<Awaited<ReturnType<F['deploy']>>> {
    assert(
      'attach' in factory && typeof factory.attach === 'function',
      `[${chainNameOrId}] dry-run deployment simulation only supports ethers factories`,
    );

    const chain = this.getChainName(chainNameOrId);
    const nonce =
      this.nextNonces[chain] ??
      (await this.getProvider(chain).getTransactionCount(this.deployerAddress));
    this.nextNonces[chain] = nonce + 1;

    const address = ethers.utils.getContractAddress({
      from: this.deployerAddress,
      nonce,
    });
    const contractName = factory.constructor.name.replace(/__factory$/, '');
    this.simulatedDeployments.push({
      chain,
      contractName,
      address,
      nonce,
    });

    rootLogger.info(
      `[${chain}] dry-run simulated ${contractName} deployment at ${address} from ${this.deployerAddress} nonce ${nonce}`,
    );

    const contract = factory.attach(address);
    Object.defineProperty(contract, 'deployTransaction', {
      value: factory.getDeployTransaction(...params),
    });
    return contract as Awaited<ReturnType<F['deploy']>>;
  }

  override async handleTx(): Promise<never> {
    throw new Error('Dry-run deployment simulation attempted to send a tx');
  }

  override async sendTransaction(): Promise<never> {
    throw new Error('Dry-run deployment simulation attempted to send a tx');
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingPackageVersionError(error: unknown): boolean {
  return isMissingSelectorCallException(error);
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

function isVersionAtLeastTarget({
  currentVersion,
}: {
  currentVersion: string;
}): boolean {
  return isValidContractVersion(currentVersion, CONTRACTS_PACKAGE_VERSION);
}

async function assertProxyAdmin({
  chain,
  provider,
  proxyAdminAddress,
  proxyAddress,
  expectedImplementation,
}: {
  chain: ChainName;
  provider: ethers.providers.Provider;
  proxyAdminAddress: Address;
  proxyAddress: Address;
  expectedImplementation: Address;
}): Promise<Address> {
  const code = await provider.getCode(proxyAdminAddress);
  assert(
    code !== '0x',
    `[${chain}] ProxyAdmin ${proxyAdminAddress} has no deployed code`,
  );

  const proxyAdminInterface = ProxyAdmin__factory.createInterface();
  const implementationResult = await provider.call({
    to: proxyAdminAddress,
    data: proxyAdminInterface.encodeFunctionData('getProxyImplementation', [
      proxyAddress,
    ]),
  });
  const [proxyAdminImplementation] = proxyAdminInterface.decodeFunctionResult(
    'getProxyImplementation',
    implementationResult,
  );
  assert(
    typeof proxyAdminImplementation === 'string',
    `[${chain}] ProxyAdmin ${proxyAdminAddress} returned invalid implementation for ${proxyAddress}`,
  );
  assert(
    eqAddress(proxyAdminImplementation, expectedImplementation),
    `[${chain}] ProxyAdmin ${proxyAdminAddress} reports implementation ${proxyAdminImplementation}, expected ${expectedImplementation}`,
  );

  return Ownable__factory.connect(proxyAdminAddress, provider).owner();
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

type TimelockOperationMatch = {
  id: string;
  status: 'scheduled' | 'done';
};

type TimelockIdempotency = {
  type: 'proxyAdminUpgrade';
  proxyAddress: Address;
};

function timelockSalt(chain: ChainName, description: string): string {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(
      `hyperlane-igp-upgrade:${chain}:${CONTRACTS_PACKAGE_VERSION}:${description}`,
    ),
  );
}

export function callMatchesTimelockIdempotency({
  call,
  scheduledTarget,
  scheduledValue,
  scheduledData,
  idempotency,
}: {
  call: UpgradeCall;
  scheduledTarget: Address;
  scheduledValue: BigNumber;
  scheduledData: string;
  idempotency?: TimelockIdempotency;
}): boolean {
  if (!eqAddress(scheduledTarget, call.to)) return false;
  if (!scheduledValue.eq(call.value)) return false;

  if (!idempotency) {
    return scheduledData === call.data;
  }

  if (idempotency.type === 'proxyAdminUpgrade') {
    return (
      getUpgradeTargetImplementation({
        tx: {
          to: scheduledTarget,
          data: scheduledData,
        },
        proxyAdminAddress: call.to,
        proxyAddress: idempotency.proxyAddress,
      }) !== undefined
    );
  }

  return false;
}

async function getExistingTimelockOperation({
  provider,
  timelock,
  call,
  idempotency,
  currentOperationId,
}: {
  provider: ethers.providers.Provider;
  timelock: ReturnType<typeof TimelockController__factory.connect>;
  call: UpgradeCall;
  idempotency?: TimelockIdempotency;
  currentOperationId: string;
}): Promise<TimelockOperationMatch | undefined> {
  if (await timelock.isOperationDone(currentOperationId)) {
    return { id: currentOperationId, status: 'done' };
  }
  if (
    (await timelock.isOperationPending(currentOperationId)) ||
    (await timelock.isOperationReady(currentOperationId))
  ) {
    return { id: currentOperationId, status: 'scheduled' };
  }
  if (!idempotency) return undefined;

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - TIMELOCK_LOOKBACK_BLOCKS);
  const eventFilter = timelock.filters.CallScheduled();
  for (
    let startBlock = fromBlock;
    startBlock <= latestBlock;
    startBlock += TIMELOCK_LOG_CHUNK_BLOCKS + 1
  ) {
    const endBlock = Math.min(
      latestBlock,
      startBlock + TIMELOCK_LOG_CHUNK_BLOCKS,
    );
    const logs = await timelock.queryFilter(eventFilter, startBlock, endBlock);
    for (const log of logs) {
      const { id, target, value, data } = log.args;
      if (
        !callMatchesTimelockIdempotency({
          call,
          scheduledTarget: target,
          scheduledValue: value,
          scheduledData: data,
          idempotency,
        })
      ) {
        continue;
      }
      if (await timelock.isOperationDone(id)) {
        return { id, status: 'done' };
      }
      if (
        (await timelock.isOperationPending(id)) ||
        (await timelock.isOperationReady(id))
      ) {
        return { id, status: 'scheduled' };
      }
    }
  }

  return undefined;
}

function getSafeGroupKey(chain: ChainName, governanceType: GovernanceType) {
  return `${chain}:${governanceType}`;
}

function splitSafeCallGroups(groups: SafeCallGroup[]): SafeCallGroup[] {
  const splitGroups: SafeCallGroup[] = [];

  for (const group of groups) {
    if (group.calls.length <= GOVERNOR_MAX_BATCH_SIZE) {
      splitGroups.push(group);
      continue;
    }

    const batchCount = Math.ceil(group.calls.length / GOVERNOR_MAX_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      splitGroups.push({
        ...group,
        calls: group.calls.slice(
          batchIndex * GOVERNOR_MAX_BATCH_SIZE,
          (batchIndex + 1) * GOVERNOR_MAX_BATCH_SIZE,
        ),
        batchIndex: batchIndex + 1,
        batchCount,
      });
    }
  }

  return splitGroups;
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

function toUpgradeCall(
  tx: AnnotatedEV5Transaction,
  defaultDescription: string,
): UpgradeCall {
  assert(tx.to, `${defaultDescription} is missing a target address`);
  assert(tx.data, `${defaultDescription} is missing calldata`);

  return {
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigNumber.from(tx.value) : BigNumber.from(0),
    description: tx.annotation ?? defaultDescription,
  };
}

function getTargetIgpConfig(chain: ChainName, config: IgpConfig): IgpConfig {
  assert(
    config.type === HookType.INTERCHAIN_GAS_PAYMASTER,
    `[${chain}] expected InterchainGasPaymaster config, got ${config.type}`,
  );

  return {
    ...deepCopy(config),
    contractVersion: CONTRACTS_PACKAGE_VERSION,
    owner: config.ownerOverrides?.interchainGasPaymaster ?? config.owner,
  };
}

async function buildHookUpdateTransactions({
  chain,
  config,
  addresses,
  multiProvider,
}: {
  chain: ChainName;
  config: IgpConfig;
  addresses: ChainMap<Address>;
  multiProvider: MultiProvider;
}): Promise<AnnotatedEV5Transaction[]> {
  assert(addresses.mailbox, `[${chain}] missing mailbox address`);
  assert(addresses.proxyAdmin, `[${chain}] missing proxyAdmin address`);
  assert(
    addresses.interchainGasPaymaster,
    `[${chain}] missing interchainGasPaymaster address`,
  );

  const targetConfig = getTargetIgpConfig(chain, config);
  const module = new EvmHookModule(multiProvider, {
    chain,
    config: targetConfig,
    addresses: {
      ...extractIsmAndHookFactoryAddresses(addresses),
      mailbox: addresses.mailbox,
      proxyAdmin: addresses.proxyAdmin,
      deployedHook: addresses.interchainGasPaymaster,
    },
  });

  return module.update(deepCopy(targetConfig));
}

export function getUpgradeTargetImplementation({
  tx,
  proxyAdminAddress,
  proxyAddress,
}: {
  tx: AnnotatedEV5Transaction;
  proxyAdminAddress: Address;
  proxyAddress: Address;
}): Address | undefined {
  if (!tx.to || !tx.data || !eqAddress(tx.to, proxyAdminAddress)) {
    return undefined;
  }

  try {
    const decoded = ProxyAdmin__factory.createInterface().decodeFunctionData(
      'upgrade',
      tx.data,
    );
    const [decodedProxy, decodedImplementation] = decoded;
    if (
      typeof decodedProxy === 'string' &&
      typeof decodedImplementation === 'string' &&
      eqAddress(decodedProxy, proxyAddress)
    ) {
      return decodedImplementation;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function getDeferredTimelockConfigChains(
  plans: Pick<ChainPlan, 'chain' | 'status' | 'detail'>[],
): ChainName[] {
  return plans
    .filter(
      (plan) =>
        (plan.status === 'timelock queued' || plan.status === 'scheduled') &&
        plan.detail.includes('config tx(s) deferred'),
    )
    .map((plan) => plan.chain);
}

async function getGovernedCallOwner({
  chain,
  provider,
  call,
  proxyAdminAddress,
  proxyAddress,
  currentImplementation,
}: {
  chain: ChainName;
  provider: ethers.providers.Provider;
  call: UpgradeCall;
  proxyAdminAddress: Address;
  proxyAddress: Address;
  currentImplementation: Address;
}): Promise<Address> {
  if (eqAddress(call.to, proxyAdminAddress)) {
    return assertProxyAdmin({
      chain,
      provider,
      proxyAdminAddress,
      proxyAddress,
      expectedImplementation: currentImplementation,
    });
  }

  return Ownable__factory.connect(call.to, provider).owner();
}

async function routeGovernedCall({
  groups,
  ica,
  chain,
  call,
  ownerAddress,
  timelockIdempotency,
}: {
  groups: Map<string, SafeCallGroup>;
  ica: InterchainAccount;
  chain: ChainName;
  call: UpgradeCall;
  ownerAddress: Address;
  timelockIdempotency?: TimelockIdempotency;
}): Promise<{
  status: 'queued' | 'timelock queued' | 'scheduled' | 'done' | 'manual';
  detail: string;
  ownerType: Owner | null;
  governanceType: GovernanceType;
}> {
  const { ownerType, governanceType } = await determineGovernanceType(
    chain,
    ownerAddress,
  );

  switch (ownerType) {
    case Owner.SAFE:
      addSafeCall(groups, chain, governanceType, call);
      return {
        status: 'queued',
        detail: `queued ${governanceType} Safe tx: ${call.description}`,
        ownerType,
        governanceType,
      };
    case Owner.ICA:
      const legacyIcaOwner = getLegacyGovernanceIcas(governanceType)[chain];
      if (legacyIcaOwner && eqAddress(legacyIcaOwner, ownerAddress)) {
        return {
          status: 'manual',
          detail: 'owned by a legacy V1 ICA; script only builds V2 ICA calls',
          ownerType,
          governanceType,
        };
      }
      await addIcaSafeCall({
        groups,
        ica,
        destination: chain,
        governanceType,
        innerCall: call,
        expectedRemoteOwner: ownerAddress,
      });
      return {
        status: 'queued',
        detail: `queued ${governanceType} ICA tx from ethereum: ${call.description}`,
        ownerType,
        governanceType,
      };
    case Owner.TIMELOCK:
      return {
        ...(await routeTimelockCall({
          groups,
          ica,
          chain,
          governanceType,
          timelockAddress: ownerAddress,
          innerCall: call,
          idempotency: timelockIdempotency,
        })),
        ownerType,
        governanceType,
      };
    case Owner.DEPLOYER:
      return {
        status: 'manual',
        detail:
          'owned by deployer; script does not execute deployer-key governed calls',
        ownerType,
        governanceType,
      };
    default:
      return {
        status: 'manual',
        detail: `unknown owner ${ownerAddress}`,
        ownerType,
        governanceType,
      };
  }
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
  idempotency,
}: {
  groups: Map<string, SafeCallGroup>;
  ica: InterchainAccount;
  chain: ChainName;
  governanceType: GovernanceType;
  timelockAddress: Address;
  innerCall: UpgradeCall;
  idempotency?: TimelockIdempotency;
}): Promise<{
  status: 'timelock queued' | 'scheduled' | 'done';
  detail: string;
}> {
  const provider = ica.multiProvider.getProvider(chain);
  const timelock = TimelockController__factory.connect(
    timelockAddress,
    provider,
  );
  const delay = await timelock.getMinDelay();
  const salt = timelockSalt(chain, innerCall.description);
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

  const existingOperation = await getExistingTimelockOperation({
    provider,
    timelock,
    call: innerCall,
    idempotency,
    currentOperationId: operationId,
  });
  if (existingOperation?.status === 'done') {
    return {
      status: 'done',
      detail: `timelock operation already executed: ${existingOperation.id}`,
    };
  }
  if (existingOperation?.status === 'scheduled') {
    return {
      status: 'scheduled',
      detail: `timelock operation already scheduled: ${existingOperation.id}`,
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
    status: 'timelock queued',
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
      const batchSuffix = group.batchCount
        ? `-${group.batchIndex}-of-${group.batchCount}`
        : '';
      const filepath = join(
        runDir,
        `${group.chain}-${group.governanceType}${batchSuffix}.raw.json`,
      );
      mkdirSync(dirname(filepath), { recursive: true });
      await writeAndFormatJsonAtPath(filepath, {
        chain: group.chain,
        chainId: multiProvider.getEvmChainId(group.chain),
        safeAddress: group.safeAddress,
        governanceType: group.governanceType,
        ...(group.batchIndex && group.batchCount
          ? { batchIndex: group.batchIndex, batchCount: group.batchCount }
          : {}),
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
    const batchSuffix = group.batchCount
      ? `-${group.batchIndex}-of-${group.batchCount}`
      : '';
    const filepath = join(
      runDir,
      `${group.chain}-${group.governanceType}${batchSuffix}.json`,
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
    skipEvmPreflight,
  } = await withOutputFile(
    withChains(
      withContext(
        withPropose(
          getArgs()
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
  assert(
    !skipEvmPreflight,
    'mainnet3 IGP upgrades require the Cancun/PUSH0 preflight; remove --skipEvmPreflight.',
  );

  const envConfig = getEnvironmentConfig(environment);
  const supportedChains = new Set(envConfig.supportedChainNames);
  const chainAddresses = getEnvAddresses(environment);
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
  assert(
    targetChains.length > 0,
    requested
      ? 'No requested chains remain after supported/legacy/skip filtering.'
      : 'No compatible chains remain after legacy/skip filtering.',
  );
  const providerChains = Array.from(new Set([...targetChains, ETHEREUM_CHAIN]));

  const baseMultiProvider = await envConfig.getMultiProvider(
    context,
    propose ? Role.Deployer : undefined,
    true,
    providerChains,
  );
  const multiProvider = propose
    ? baseMultiProvider
    : new DryRunDeployMultiProvider(baseMultiProvider, DEPLOYER);
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
    const config = envConfig.igp[chain];
    try {
      if (!skipEvmPreflight) {
        await assertCancunCompatible(chain, provider);
      }
      assert(config, `[${chain}] missing IGP config`);

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
      const proxyAdminOwner = await assertProxyAdmin({
        chain,
        provider,
        proxyAdminAddress: actualProxyAdmin,
        proxyAddress: interchainGasPaymaster,
        expectedImplementation: currentImplementation,
      });

      const implementationUpgradeRequired =
        !currentVersion ||
        !isVersionAtLeastTarget({
          currentVersion,
        });
      if (implementationUpgradeRequired) {
        const { ownerType, governanceType } = await determineGovernanceType(
          chain,
          proxyAdminOwner,
        );
        const legacyIcaOwner = getLegacyGovernanceIcas(governanceType)[chain];
        if (
          ownerType === Owner.DEPLOYER ||
          ownerType === Owner.UNKNOWN ||
          (ownerType === Owner.ICA &&
            legacyIcaOwner &&
            eqAddress(legacyIcaOwner, proxyAdminOwner))
        ) {
          plans.push({
            chain,
            interchainGasPaymaster,
            currentImplementation,
            currentVersion,
            targetVersion: CONTRACTS_PACKAGE_VERSION,
            proxyAdmin: actualProxyAdmin,
            proxyAdminOwner,
            ownerType,
            governanceType,
            status: 'manual',
            detail:
              ownerType === Owner.ICA
                ? 'ProxyAdmin is owned by a legacy V1 ICA; script only builds V2 ICA calls'
                : `ProxyAdmin owner ${proxyAdminOwner} is not routeable`,
          });
          continue;
        }
      }

      const deploymentsBefore =
        multiProvider instanceof DryRunDeployMultiProvider
          ? multiProvider.simulatedDeployments.length
          : 0;
      const transactions = await buildHookUpdateTransactions({
        chain,
        config,
        addresses,
        multiProvider,
      });
      const simulatedDeployments =
        multiProvider instanceof DryRunDeployMultiProvider
          ? multiProvider.simulatedDeployments.slice(deploymentsBefore)
          : undefined;

      if (transactions.length === 0) {
        plans.push({
          chain,
          interchainGasPaymaster,
          currentImplementation,
          currentVersion,
          targetVersion: CONTRACTS_PACKAGE_VERSION,
          proxyAdmin: actualProxyAdmin,
          proxyAdminOwner,
          status: 'no change',
          detail: 'hook module produced no update transactions',
          ...(simulatedDeployments?.length ? { simulatedDeployments } : {}),
        });
        continue;
      }

      const upgradeIndex = transactions.findIndex(
        (tx) =>
          !!getUpgradeTargetImplementation({
            tx,
            proxyAdminAddress: actualProxyAdmin,
            proxyAddress: interchainGasPaymaster,
          }),
      );
      const targetImplementation =
        upgradeIndex >= 0
          ? getUpgradeTargetImplementation({
              tx: transactions[upgradeIndex],
              proxyAdminAddress: actualProxyAdmin,
              proxyAddress: interchainGasPaymaster,
            })
          : undefined;

      const routeDetails: string[] = [];
      let status = 'queued';
      let ownerType: Owner | null | undefined;
      let governanceType: GovernanceType | undefined;
      let routedTransactionCount = 0;
      let manualTransactionCount = 0;
      let doneTransactionCount = 0;
      let hasTimelockQueued = false;
      let hasScheduled = false;

      if (upgradeIndex >= 0) {
        const upgradeCall = toUpgradeCall(
          transactions[upgradeIndex],
          `Upgrade IGP ${interchainGasPaymaster} to ${CONTRACTS_PACKAGE_VERSION}`,
        );
        const route = await routeGovernedCall({
          groups: safeGroups,
          ica,
          chain,
          call: upgradeCall,
          ownerAddress: proxyAdminOwner,
          timelockIdempotency: {
            type: 'proxyAdminUpgrade',
            proxyAddress: interchainGasPaymaster,
          },
        });
        status = route.status === 'done' ? 'error' : route.status;
        ownerType = route.ownerType;
        governanceType = route.governanceType;
        routeDetails.push(route.detail);
        if (route.status !== 'done') {
          routedTransactionCount += 1;
        }

        if (
          route.status === 'timelock queued' ||
          route.status === 'scheduled' ||
          route.status === 'done'
        ) {
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
            transactionCount: routedTransactionCount,
            status,
            detail:
              route.status === 'done'
                ? route.detail
                : `${route.detail}; ${transactions.length - 1} config tx(s) deferred until the timelock upgrade executes`,
            ...(simulatedDeployments?.length ? { simulatedDeployments } : {}),
          });
          continue;
        }

        if (route.status === 'manual') {
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
            transactionCount: routedTransactionCount,
            status,
            detail: route.detail,
            ...(simulatedDeployments?.length ? { simulatedDeployments } : {}),
          });
          continue;
        }
      }

      for (const [index, transaction] of transactions.entries()) {
        if (index === upgradeIndex) continue;
        const call = toUpgradeCall(
          transaction,
          `IGP update tx ${index + 1} for ${chain}`,
        );
        const ownerAddress = await getGovernedCallOwner({
          chain,
          provider,
          call,
          proxyAdminAddress: actualProxyAdmin,
          proxyAddress: interchainGasPaymaster,
          currentImplementation,
        });
        const route = await routeGovernedCall({
          groups: safeGroups,
          ica,
          chain,
          call,
          ownerAddress,
        });
        ownerType ??= route.ownerType;
        governanceType ??= route.governanceType;
        routeDetails.push(route.detail);
        if (route.status === 'manual') {
          manualTransactionCount += 1;
          continue;
        }
        if (route.status === 'done') {
          doneTransactionCount += 1;
          continue;
        }

        routedTransactionCount += 1;
        hasTimelockQueued ||= route.status === 'timelock queued';
        hasScheduled ||= route.status === 'scheduled';
      }

      if (manualTransactionCount > 0) {
        status = routedTransactionCount > 0 ? 'partial' : 'manual';
      } else if (hasTimelockQueued) {
        status = 'timelock queued';
      } else if (hasScheduled) {
        status = 'scheduled';
      } else if (routedTransactionCount === 0 && doneTransactionCount > 0) {
        status = 'skipped';
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
        transactionCount: routedTransactionCount,
        status,
        detail: routeDetails.join('; '),
        ...(simulatedDeployments?.length ? { simulatedDeployments } : {}),
      });
    } catch (error) {
      plans.push({
        chain,
        interchainGasPaymaster,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        status: 'error',
        detail: formatError(error),
      });
    }
  }

  const groups = splitSafeCallGroups([...safeGroups.values()]);
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
    ...(proposalResults.length > 0 ? { proposalResults } : {}),
    safeGroups: groups.map((group) => ({
      chain: group.chain,
      governanceType: group.governanceType,
      safeAddress: group.safeAddress,
      transactionCount: group.calls.length,
      ...(group.batchIndex && group.batchCount
        ? { batchIndex: group.batchIndex, batchCount: group.batchCount }
        : {}),
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
  const deferredTimelockChains = getDeferredTimelockConfigChains(plans);
  if (deferredTimelockChains.length > 0) {
    rootLogger.warn(
      [
        `Config txs were deferred for timelock-owned upgrade chain(s): ${deferredTimelockChains.join(', ')}`,
        'Execute the timelock upgrade first, then rerun this script for those chains to propose the hook-module config txs.',
      ].join('\n'),
    );
  }
  if (
    plans.some((plan) => plan.status === 'error') ||
    proposalResults.some((result) => result.status === 'error') ||
    (propose && rawFallbackGroupKeys.size > 0)
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
