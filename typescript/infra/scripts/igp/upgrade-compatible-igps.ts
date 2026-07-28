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
  ContractVerificationInput,
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
  concurrentMap,
  deepCopy,
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
  getLegacyGovernanceIcas,
} from '../../config/environments/mainnet3/governance/utils.js';
import {
  DEPLOYER,
  upgradeTimelocks,
} from '../../config/environments/mainnet3/owners.js';
import { getEnvAddresses } from '../../config/registry.js';
import { chainsToSkip, legacyIgpChains } from '../../src/config/chain.js';
import { determineGovernanceType, Owner } from '../../src/governance.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { GOVERNOR_MAX_BATCH_SIZE } from '../../src/govern/constants.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { Role } from '../../src/roles.js';
import { logTable } from '../../src/utils/log.js';
import { getTimelockLogBlockRange } from '../../src/utils/timelock.js';
import { writeAndFormatJsonAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  getModuleDirectory,
  Modules,
  withChains,
  withContext,
  withOutputFile,
  withPropose,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ETHEREUM_CHAIN: ChainName = 'ethereum';
const OUTPUT_ROOT = 'igp-upgrade-output';
const CANCUN_PROBE_INIT_CODE = '0x5f5f5d5f5c5f5260205ff3';
const localSafeUpgradeTimelockGovernance: ChainMap<GovernanceType | undefined> =
  {
    arbitrum: GovernanceType.AbacusWorks,
  };
// Timelock upgrade idempotency needs log scanning because CREATE deployments
// change the implementation address in the scheduled calldata across reruns.
// The per-query block range comes from the same conservative timelock helper
// used by the pending-timelock scripts.
const TIMELOCK_LOOKBACK_BLOCKS = 2_000_000;

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

type IcaCallGroup = {
  destination: ChainName;
  governanceType: GovernanceType;
  owner: Address;
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

type SimulatedDeployment = {
  chain: ChainName;
  contractName: string;
  address: Address;
  nonce: number;
};

type UpgradeGovernanceRoute = {
  ownerType: Owner | null;
  governanceType: GovernanceType;
  timelockProposer?: 'ica' | 'safe';
};

class VerificationAwareEvmHookModule extends EvmHookModule {
  get verificationInputs(): ChainMap<ContractVerificationInput[]> {
    return this.deployer.verificationInputs;
  }
}

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

export async function determineUpgradeGovernanceRoute(
  chain: ChainName,
  ownerAddress: Address,
): Promise<UpgradeGovernanceRoute> {
  const upgradeTimelock = upgradeTimelocks[chain];
  const localSafeGovernanceType = localSafeUpgradeTimelockGovernance[chain];
  if (
    upgradeTimelock &&
    localSafeGovernanceType &&
    eqAddress(upgradeTimelock, ownerAddress)
  ) {
    return {
      ownerType: Owner.TIMELOCK,
      governanceType: localSafeGovernanceType,
      timelockProposer: 'safe',
    };
  }

  return determineGovernanceType(chain, ownerAddress);
}

export function mergeVerificationInputs(
  existingInputs: ChainMap<ContractVerificationInput[]>,
  newInputs: ChainMap<ContractVerificationInput[]>,
): ChainMap<ContractVerificationInput[]> {
  const mergedInputs: ChainMap<ContractVerificationInput[]> =
    deepCopy(existingInputs);
  for (const [chain, inputs] of Object.entries(newInputs)) {
    const chainInputs = (mergedInputs[chain] ??= []);
    for (const input of inputs) {
      if (
        chainInputs.some(
          (existing) =>
            existing.name === input.name &&
            eqAddress(existing.address, input.address) &&
            existing.constructorArguments === input.constructorArguments &&
            existing.isProxy === input.isProxy,
        )
      ) {
        continue;
      }
      chainInputs.push(input);
    }
  }
  return mergedInputs;
}

async function writeVerificationInputs(
  environment: 'mainnet3',
  newInputs: ChainMap<ContractVerificationInput[]>,
) {
  if (Object.keys(newInputs).length === 0) return;

  const verificationPath = join(
    getModuleDirectory(environment, Modules.INTERCHAIN_GAS_PAYMASTER),
    'verification.json',
  );
  const existingInputs =
    readJson<ChainMap<ContractVerificationInput[]>>(verificationPath);
  await writeAndFormatJsonAtPath(
    verificationPath,
    mergeVerificationInputs(existingInputs, newInputs),
  );
  rootLogger.info(
    `Wrote deployment verification inputs to ${verificationPath}`,
  );
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
  chain,
  provider,
  timelock,
  call,
  idempotency,
  currentOperationId,
}: {
  chain: ChainName;
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
  const logBlockRange = getTimelockLogBlockRange(chain);
  for (
    let startBlock = fromBlock;
    startBlock <= latestBlock;
    startBlock += logBlockRange + 1
  ) {
    const endBlock = Math.min(latestBlock, startBlock + logBlockRange);
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

function getIcaCallGroupKey({
  destination,
  governanceType,
  owner,
}: {
  destination: ChainName;
  governanceType: GovernanceType;
  owner: Address;
}) {
  return `${destination}:${governanceType}:${owner}`;
}

function addIcaCall(
  groups: Map<string, IcaCallGroup>,
  destination: ChainName,
  governanceType: GovernanceType,
  owner: Address,
  call: UpgradeCall,
) {
  const key = getIcaCallGroupKey({ destination, governanceType, owner });
  const existing = groups.get(key);
  if (existing) {
    existing.calls.push(call);
    return;
  }

  groups.set(key, {
    destination,
    governanceType,
    owner,
    calls: [call],
  });
}

async function assertIcaOwner({
  ica,
  destination,
  governanceType,
  ownerAddress,
}: {
  ica: InterchainAccount;
  destination: ChainName;
  governanceType: GovernanceType;
  ownerAddress: Address;
}) {
  const owner = getGovernanceSafes(governanceType)[ETHEREUM_CHAIN];
  assert(
    owner,
    `No ${governanceType} Safe configured on ${ETHEREUM_CHAIN}; cannot propose ICA call for ${destination}`,
  );

  const expectedIca = await ica.getAccount(destination, {
    origin: ETHEREUM_CHAIN,
    owner,
  });
  assert(
    eqAddress(expectedIca, ownerAddress),
    `[${destination}] expected ${governanceType} ICA ${expectedIca}, but owner is ${ownerAddress}`,
  );
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

  // Strip tokenOracleConfig: those oracles require the new implementation and
  // will be deployed/configured by deploy.ts -m igp after this upgrade executes.
  const { tokenOracleConfig: _stripped, ...rest } = deepCopy(config) as {
    tokenOracleConfig?: unknown;
    [key: string]: unknown;
  };
  return {
    ...rest,
    contractVersion: CONTRACTS_PACKAGE_VERSION,
    owner: config.ownerOverrides?.interchainGasPaymaster ?? config.owner,
  } as IgpConfig;
}

async function buildHookUpdateTransactions({
  chain,
  config,
  addresses,
  multiProvider,
  onVerificationInputs,
}: {
  chain: ChainName;
  config: IgpConfig;
  addresses: ChainMap<Address>;
  multiProvider: MultiProvider;
  onVerificationInputs?: (inputs: ContractVerificationInput[]) => void;
}): Promise<AnnotatedEV5Transaction[]> {
  assert(addresses.mailbox, `[${chain}] missing mailbox address`);
  assert(addresses.proxyAdmin, `[${chain}] missing proxyAdmin address`);
  assert(
    addresses.interchainGasPaymaster,
    `[${chain}] missing interchainGasPaymaster address`,
  );

  const targetConfig = getTargetIgpConfig(chain, config);
  const module = new VerificationAwareEvmHookModule(multiProvider, {
    chain,
    config: targetConfig,
    addresses: {
      ...extractIsmAndHookFactoryAddresses(addresses),
      mailbox: addresses.mailbox,
      proxyAdmin: addresses.proxyAdmin,
      deployedHook: addresses.interchainGasPaymaster,
    },
  });

  try {
    return await module.update(deepCopy(targetConfig));
  } finally {
    onVerificationInputs?.(module.verificationInputs[chain] ?? []);
  }
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
    // Not a ProxyAdmin.upgrade call; callers use undefined as a non-match.
    return undefined;
  }

  return undefined;
}

export async function executeDeployerOwnedCall({
  chain,
  call,
  multiProvider,
}: {
  chain: ChainName;
  call: UpgradeCall;
  multiProvider: MultiProvider;
}): Promise<{
  status: 'error' | 'executed';
  detail: string;
}> {
  try {
    rootLogger.info(
      `[${chain}] executing deployer-key upgrade: ${call.description}`,
    );
    await multiProvider.sendTransaction(chain, {
      to: call.to,
      data: call.data,
      value: call.value,
    });
    return {
      status: 'executed',
      detail: `executed deployer-key upgrade: ${call.description}`,
    };
  } catch (error) {
    return {
      status: 'error',
      detail: `deployer-key upgrade failed: ${formatError(error)}`,
    };
  }
}

async function routeGovernedCall({
  groups,
  icaGroups,
  ica,
  chain,
  call,
  ownerAddress,
  timelockIdempotency,
  propose,
  multiProvider,
}: {
  groups: Map<string, SafeCallGroup>;
  icaGroups: Map<string, IcaCallGroup>;
  ica: InterchainAccount;
  chain: ChainName;
  call: UpgradeCall;
  ownerAddress: Address;
  timelockIdempotency?: TimelockIdempotency;
  propose: boolean;
  multiProvider: MultiProvider;
}): Promise<{
  status:
    | 'queued'
    | 'timelock queued'
    | 'scheduled'
    | 'done'
    | 'error'
    | 'manual'
    | 'executed';
  detail: string;
  ownerType: Owner | null;
  governanceType: GovernanceType;
}> {
  const { ownerType, governanceType, timelockProposer } =
    await determineUpgradeGovernanceRoute(chain, ownerAddress);

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
      await assertIcaOwner({
        ica,
        destination: chain,
        governanceType,
        ownerAddress,
      });
      addIcaCall(icaGroups, chain, governanceType, ownerAddress, call);
      return {
        status: 'queued',
        detail: `queued ${governanceType} ICA inner tx from ethereum: ${call.description}`,
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
          proposerType: timelockProposer,
        })),
        ownerType,
        governanceType,
      };
    case Owner.DEPLOYER:
      if (!propose) {
        return {
          status: 'manual',
          detail:
            'owned by deployer; pass --propose to execute directly with deployer key',
          ownerType,
          governanceType,
        };
      }
      return {
        ...(await executeDeployerOwnedCall({ chain, call, multiProvider })),
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

async function flushIcaCallGroups({
  safeGroups,
  icaGroups,
  ica,
}: {
  safeGroups: Map<string, SafeCallGroup>;
  icaGroups: Map<string, IcaCallGroup>;
  ica: InterchainAccount;
}) {
  for (const group of icaGroups.values()) {
    const safes = getGovernanceSafes(group.governanceType);
    const owner = safes[ETHEREUM_CHAIN];
    assert(
      owner,
      `No ${group.governanceType} Safe configured on ${ETHEREUM_CHAIN}; cannot propose ICA call for ${group.destination}`,
    );

    const accountConfig = {
      origin: ETHEREUM_CHAIN,
      owner,
    };
    const innerCalls = group.calls.map((call) => ({
      to: call.to,
      data: call.data,
      value: call.value.toString(),
    }));
    const gasLimit = await ica.estimateIcaHandleGas({
      origin: ETHEREUM_CHAIN,
      destination: group.destination,
      innerCalls,
      config: accountConfig,
    });
    const hookMetadata = formatStandardHookMetadata({
      gasLimit: gasLimit.toBigInt(),
      refundAddress: accountConfig.owner,
    });
    const callRemote = await ica.getCallRemote({
      chain: ETHEREUM_CHAIN,
      destination: group.destination,
      innerCalls,
      config: accountConfig,
      hookMetadata,
    });

    assert(
      callRemote.to && callRemote.data,
      `[${group.destination}] could not build ICA callRemote transaction`,
    );

    addSafeCall(safeGroups, ETHEREUM_CHAIN, group.governanceType, {
      to: callRemote.to,
      data: callRemote.data,
      value: callRemote.value ?? BigNumber.from(0),
      description: `ICA ${group.destination}: ${group.calls.length} ordered tx(s): ${group.calls
        .map((call) => call.description)
        .join('; ')}`,
    });
  }
}

async function routeTimelockCall({
  groups,
  ica,
  chain,
  governanceType,
  timelockAddress,
  innerCall,
  idempotency,
  proposerType,
}: {
  groups: Map<string, SafeCallGroup>;
  ica: InterchainAccount;
  chain: ChainName;
  governanceType: GovernanceType;
  timelockAddress: Address;
  innerCall: UpgradeCall;
  idempotency?: TimelockIdempotency;
  proposerType?: 'ica' | 'safe';
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
    chain,
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

  const proposeViaSafe = chain === ETHEREUM_CHAIN || proposerType === 'safe';
  const proposer = proposeViaSafe
    ? getGovernanceSafes(governanceType)[chain]
    : getGovernanceIcaAddress(chain, governanceType);
  assert(
    proposer,
    `[${chain}] no ${governanceType} proposer address available for timelock ${timelockAddress}`,
  );
  assert(
    await timelock.hasRole(PROPOSER_ROLE, proposer),
    `[${chain}] ${proposer} does not have PROPOSER_ROLE on timelock ${timelockAddress}`,
  );

  if (proposeViaSafe) {
    addSafeCall(groups, chain, governanceType, scheduleCall);
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
    concurrency: chainConcurrency,
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
            })
            .option('concurrency', {
              type: 'number',
              default: 8,
              describe: 'Number of chains to plan concurrently',
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
  assert(chainConcurrency > 0, '--concurrency must be greater than 0');

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
  const icaGroups = new Map<string, IcaCallGroup>();
  const plans: ChainPlan[] = [];
  const verificationInputs: ChainMap<ContractVerificationInput[]> = {};
  const targetChainIndexes = new Map(
    targetChains.map((chain, index) => [chain, index]),
  );

  await concurrentMap(chainConcurrency, targetChains, async (chain) => {
    const metadata = multiProvider.getChainMetadata(chain);
    if (!isEVMLike(metadata.protocol)) {
      plans.push({
        chain,
        targetVersion: CONTRACTS_PACKAGE_VERSION,
        status: 'skipped',
        detail: `non-EVM protocol ${metadata.protocol}`,
      });
      return;
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
      return;
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
        const { ownerType, governanceType } =
          await determineUpgradeGovernanceRoute(chain, proxyAdminOwner);
        const legacyIcaOwner = getLegacyGovernanceIcas(governanceType)[chain];
        const isUnroutable =
          ownerType === Owner.UNKNOWN ||
          (ownerType === Owner.ICA &&
            legacyIcaOwner &&
            eqAddress(legacyIcaOwner, proxyAdminOwner)) ||
          (ownerType === Owner.DEPLOYER && !propose);
        if (isUnroutable) {
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
                : ownerType === Owner.DEPLOYER
                  ? 'owned by deployer; pass --propose to execute directly with deployer key'
                  : `ProxyAdmin owner ${proxyAdminOwner} is not routeable`,
          });
          return;
        }
      }

      const deploymentsBefore =
        multiProvider instanceof DryRunDeployMultiProvider
          ? multiProvider.simulatedDeployments.filter(
              (deployment) => deployment.chain === chain,
            ).length
          : 0;
      const transactions = await buildHookUpdateTransactions({
        chain,
        config,
        addresses,
        multiProvider,
        onVerificationInputs: propose
          ? (inputs) => {
              if (inputs.length > 0) verificationInputs[chain] = inputs;
            }
          : undefined,
      });
      const simulatedDeployments =
        multiProvider instanceof DryRunDeployMultiProvider
          ? multiProvider.simulatedDeployments
              .filter((deployment) => deployment.chain === chain)
              .slice(deploymentsBefore)
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
        return;
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

      let ownerType: Owner | null | undefined;
      let governanceType: GovernanceType | undefined;
      let routedTransactionCount = 0;

      if (upgradeIndex >= 0) {
        const upgradeCall = toUpgradeCall(
          transactions[upgradeIndex],
          `Upgrade IGP ${interchainGasPaymaster} to ${CONTRACTS_PACKAGE_VERSION}`,
        );
        const route = await routeGovernedCall({
          groups: safeGroups,
          icaGroups,
          ica,
          chain,
          call: upgradeCall,
          ownerAddress: proxyAdminOwner,
          timelockIdempotency: {
            type: 'proxyAdminUpgrade',
            proxyAddress: interchainGasPaymaster,
          },
          propose,
          multiProvider,
        });
        const status = route.status === 'done' ? 'skipped' : route.status;
        ownerType = route.ownerType;
        governanceType = route.governanceType;
        if (route.status === 'queued' || route.status === 'timelock queued') {
          routedTransactionCount += 1;
        }
        const configTxCount = transactions.length - 1;
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
          detail: [
            route.status === 'done'
              ? `${route.detail}; upgrade already executed`
              : route.detail,
            configTxCount > 0
              ? `${configTxCount} hook-module config tx(s) intentionally not proposed; run deploy.ts -m igp after upgrade execution`
              : 'run deploy.ts -m igp after upgrade execution to apply/confirm config',
          ].join('; '),
          ...(simulatedDeployments?.length ? { simulatedDeployments } : {}),
        });
        return;
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
        transactionCount: 0,
        status: 'no upgrade',
        detail: `${transactions.length} hook-module config tx(s) intentionally not proposed; run deploy.ts -m igp to apply config`,
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
  });
  plans.sort(
    (a, b) =>
      (targetChainIndexes.get(a.chain) ?? Number.MAX_SAFE_INTEGER) -
      (targetChainIndexes.get(b.chain) ?? Number.MAX_SAFE_INTEGER),
  );

  if (propose) {
    await writeVerificationInputs(environment, verificationInputs);
  }

  await flushIcaCallGroups({
    safeGroups,
    icaGroups,
    ica,
  });

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
  const upgradeChains = plans
    .filter(
      (plan) =>
        !!plan.targetImplementation &&
        [
          'queued',
          'timelock queued',
          'scheduled',
          'skipped',
          'executed',
        ].includes(plan.status),
    )
    .map((plan) => plan.chain);
  if (upgradeChains.length > 0) {
    rootLogger.warn(
      [
        `Upgrade-only mode: apply IGP config after upgrade execution for chain(s): ${upgradeChains.join(', ')}`,
        `pnpm -C typescript/infra exec tsx scripts/deploy.ts -e ${environment} -x ${context} -m igp --chains ${upgradeChains.join(' ')}`,
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
