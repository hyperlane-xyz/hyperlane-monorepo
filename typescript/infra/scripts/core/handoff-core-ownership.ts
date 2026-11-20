import { pathToFileURL } from 'url';

import { BigNumber, Contract, ethers } from 'ethers';
import yargs from 'yargs';

import type { ChainAddresses } from '@hyperlane-xyz/registry';
import { InterchainAccount, proxyImplementation } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  assert,
  eqAddress,
  formatStandardHookMetadata,
  isEVMLike,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readYamlOrJson, writeJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import {
  CoreOwnershipHandoffConfigSchema,
  CoreOwnershipHandoffPlan,
  OwnableCandidate,
  OwnableState,
  buildChainHandoffPlan,
  collectOwnableCandidates,
  finalizeHandoffPlan,
  hasPlannedCalls,
} from '../../src/govern/core-ownership-handoff.js';
import { DEPLOYERS } from '../../src/governance.js';
import { SafeMultiSend, SignerMultiSend } from '../../src/govern/multisend.js';
import { Role } from '../../src/roles.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ownableReadInterface = new ethers.utils.Interface([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
]);
const beneficiaryReadInterface = new ethers.utils.Interface([
  'function beneficiary() view returns (address)',
]);
const safeInterface = new ethers.utils.Interface([
  'function VERSION() view returns (string)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);
const BENEFICIARY_LABELS = new Set(['interchainGasPaymaster', 'protocolFee']);
const pendingOwnerSelector = ownableReadInterface
  .getSighash('pendingOwner')
  .slice(2)
  .toLowerCase();

type TargetType = CoreOwnershipHandoffPlan['chains'][number]['targetType'];

async function readAddress(
  contract: Contract,
  functionName: 'owner' | 'pendingOwner' | 'beneficiary',
): Promise<Address> {
  return ethers.utils.getAddress(await contract[functionName]());
}

function codeContainsPendingOwner(code: string): boolean {
  return code.toLowerCase().includes(pendingOwnerSelector);
}

async function supportsPendingOwner(
  provider: ethers.providers.Provider,
  address: Address,
  code: string,
): Promise<boolean> {
  if (codeContainsPendingOwner(code)) return true;

  const implementation = await proxyImplementation(provider, address);
  if (eqAddress(implementation, ethers.constants.AddressZero)) return false;
  return codeContainsPendingOwner(await provider.getCode(implementation));
}

export async function readOwnableState(
  provider: ethers.providers.Provider,
  candidate: OwnableCandidate,
): Promise<OwnableState> {
  const code = await provider.getCode(candidate.address);
  assert(
    code !== '0x',
    `${candidate.labels.join(', ')} (${candidate.address}) has no contract code`,
  );

  const ownable = new Contract(
    candidate.address,
    ownableReadInterface,
    provider,
  );
  const owner = await readAddress(ownable, 'owner');

  const pendingOwner = (await supportsPendingOwner(
    provider,
    candidate.address,
    code,
  ))
    ? await readAddress(ownable, 'pendingOwner')
    : undefined;
  const managesBeneficiary = candidate.labels.some((label) =>
    BENEFICIARY_LABELS.has(label),
  );
  let beneficiary: Address | undefined;
  if (managesBeneficiary) {
    beneficiary = await readAddress(
      new Contract(candidate.address, beneficiaryReadInterface, provider),
      'beneficiary',
    );
  }

  return {
    ...candidate,
    owner,
    beneficiary,
    ownershipMode: pendingOwner ? 'two-step' : 'one-step',
  };
}

async function classifyTarget(
  provider: ethers.providers.Provider,
  target: Address,
): Promise<TargetType> {
  const code = await provider.getCode(target);
  if (code === '0x') return 'eoa';
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return 'delegated-eoa';

  try {
    const safe = new Contract(target, safeInterface, provider);
    const version: string = await safe.VERSION();
    const threshold: BigNumber = await safe.getThreshold();
    const owners: Address[] = await safe.getOwners();
    assert(
      threshold.gt(0) && threshold.lte(owners.length),
      `Target ${target} has invalid Safe threshold ${threshold.toString()} for ${owners.length} owners`,
    );
    rootLogger.info(`Target ${target} is Safe ${version}`);
    return 'safe';
  } catch {
    return 'contract';
  }
}

function toCallData(call: {
  to: Address;
  data: string;
  value: string;
}): CallData {
  return {
    to: call.to,
    data: call.data,
    value: BigNumber.from(call.value),
  };
}

async function buildIcaCall({
  ica,
  origin,
  destination,
  governanceSafe,
  localRouter,
  routerOverride,
  calls,
}: {
  ica: InterchainAccount;
  origin: string;
  destination: string;
  governanceSafe: Address;
  localRouter?: Address;
  routerOverride?: Address;
  calls: CoreOwnershipHandoffPlan['chains'][number]['calls']['ica'];
}): Promise<CoreOwnershipHandoffPlan['chains'][number]['icaCall']> {
  if (calls.length === 0) return undefined;

  const innerCalls = calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value,
  }));
  const accountConfig = {
    origin,
    owner: governanceSafe,
    ...(localRouter ? { localRouter } : {}),
    ...(routerOverride ? { routerOverride } : {}),
  };
  const gasLimit = await ica.estimateIcaHandleGas({
    origin,
    destination,
    innerCalls,
    config: accountConfig,
  });
  const callRemote = await ica.getCallRemote({
    chain: origin,
    destination,
    innerCalls,
    config: accountConfig,
    hookMetadata: formatStandardHookMetadata({
      gasLimit: gasLimit.toBigInt(),
      refundAddress: governanceSafe,
    }),
  });
  assert(callRemote.to && callRemote.data, 'Failed to build ICA call');
  return {
    to: callRemote.to,
    data: callRemote.data,
    value: (callRemote.value?.mul(2) ?? BigNumber.from(0)).toString(),
    description: `ICA ownership handoff from ${origin} to ${destination}`,
  };
}

async function verifyExecutedCalls(
  plan: CoreOwnershipHandoffPlan,
  multiProvider: Awaited<
    ReturnType<ReturnType<typeof getEnvironmentConfig>['getMultiProvider']>
  >,
): Promise<void> {
  for (const chainPlan of plan.chains) {
    const provider = multiProvider.getProvider(chainPlan.chain);
    for (const call of chainPlan.calls.deployer) {
      const iface =
        call.operation === 'setBeneficiary'
          ? beneficiaryReadInterface
          : ownableReadInterface;
      const functionName =
        call.operation === 'setBeneficiary' ? 'beneficiary' : 'owner';
      const actual = await readAddress(
        new Contract(call.to, iface, provider),
        functionName,
      );
      assert(
        eqAddress(actual, chainPlan.target),
        `[${chainPlan.chain}] ${call.operation} verification failed for ${call.to}; got ${actual}`,
      );
    }
  }
}

export async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .option('config', {
      type: 'string',
      demandOption: true,
      description: 'YAML or JSON handoff configuration',
    })
    .option('out', {
      type: 'string',
      description: 'Write the deterministic execution plan as JSON',
    })
    .option('expected-plan-hash', {
      type: 'string',
      description: 'Required for writes; must match a previously reviewed plan',
    })
    .option('submit-deployer', {
      type: 'boolean',
      default: false,
      description: 'Execute calls owned by the environment deployer key',
    })
    .option('propose-safe', {
      type: 'boolean',
      default: false,
      description: 'Propose destination Safe and origin ICA Safe batches',
    })
    .strict()
    .parse();

  const config = CoreOwnershipHandoffConfigSchema.parse(
    readYamlOrJson<unknown>(argv.config),
  );
  const chains = Object.keys(config.chains).sort();
  const requestedChains = [...new Set([config.governance.origin, ...chains])];
  const environmentConfig = getEnvironmentConfig(config.environment);
  const multiProvider = await environmentConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    requestedChains,
  );
  const registry = await environmentConfig.getRegistry(true, requestedChains);
  const allAddresses = await registry.getAddresses();

  const governanceSafe =
    config.governance.safe ??
    getGovernanceSafes(config.governance.type)[config.governance.origin];
  assert(
    governanceSafe,
    `Missing ${config.governance.type} governance Safe on ${config.governance.origin}; set governance.safe`,
  );

  const icaAddresses: Record<string, ChainAddresses> = {};
  for (const chain of requestedChains) {
    const addresses = allAddresses[chain];
    assert(addresses, `[${chain}] missing registry addresses`);
    assert(
      addresses.interchainAccountRouter,
      `[${chain}] missing interchainAccountRouter`,
    );
    icaAddresses[chain] = addresses;
  }
  const ica = InterchainAccount.fromAddressesMap(icaAddresses, multiProvider);
  const deployer = DEPLOYERS[config.environment];
  const chainPlans: CoreOwnershipHandoffPlan['chains'] = [];

  for (const chain of chains) {
    const chainConfig = config.chains[chain];
    const addresses = allAddresses[chain];
    assert(addresses, `[${chain}] missing registry addresses`);
    const provider = multiProvider.getProvider(chain);
    assert(
      isEVMLike(multiProvider.getProtocol(chain)),
      `[${chain}] core ownership handoff only supports EVM chains`,
    );
    const targetType = await classifyTarget(provider, chainConfig.owner);
    assert(
      targetType !== 'contract' || chainConfig.allowContractOwner,
      `[${chain}] target ${chainConfig.owner} is a non-Safe contract; set allowContractOwner only after verifying it can administer the deployment`,
    );

    const accountConfig = {
      origin: config.governance.origin,
      owner: governanceSafe,
      ...(config.governance.localRouter
        ? { localRouter: config.governance.localRouter }
        : {}),
      ...(chainConfig.ica?.routerOverride
        ? { routerOverride: chainConfig.ica.routerOverride }
        : {}),
    };
    const derivedIca = await ica.getAccount(chain, accountConfig);
    const sourceIca = chainConfig.ica?.account ?? derivedIca;
    assert(
      eqAddress(sourceIca, derivedIca),
      `[${chain}] configured ICA ${sourceIca} does not match derived ICA ${derivedIca}; check router overrides`,
    );
    const sourceSafe =
      chainConfig.sourceSafe ??
      getGovernanceSafes(config.governance.type)[chain];

    const { candidates, missingRegistryLabels } = collectOwnableCandidates(
      addresses,
      chainConfig.additionalContracts,
    );
    const states = await Promise.all(
      candidates.map((candidate) => readOwnableState(provider, candidate)),
    );
    assert(states.length > 0, `[${chain}] no Ownable contracts discovered`);

    const chainPlan = buildChainHandoffPlan({
      chain,
      target: chainConfig.owner,
      targetType,
      deployer,
      sourceIca,
      sourceSafe,
      states,
      missingRegistryLabels,
    });
    chainPlan.icaCall = await buildIcaCall({
      ica,
      origin: config.governance.origin,
      destination: chain,
      governanceSafe,
      localRouter: config.governance.localRouter,
      routerOverride: chainConfig.ica?.routerOverride,
      calls: chainPlan.calls.ica,
    });
    chainPlans.push(chainPlan);
  }

  const plan = finalizeHandoffPlan({
    environment: config.environment,
    governance: {
      origin: config.governance.origin,
      type: config.governance.type,
      safe: governanceSafe,
    },
    chains: chainPlans,
  });
  rootLogger.info(JSON.stringify(plan, null, 2));
  if (argv.out) {
    writeJson(argv.out, plan);
    rootLogger.info(`Wrote plan ${plan.hash} to ${argv.out}`);
  }

  if (!argv.submitDeployer && !argv.proposeSafe) {
    rootLogger.info(
      'Dry run only; pass --submit-deployer and/or --propose-safe after reviewing the plan',
    );
    return;
  }
  assert(argv.out, '--out is required when executing or proposing calls');
  assert(
    argv.expectedPlanHash === plan.hash,
    `Plan hash mismatch: expected ${argv.expectedPlanHash ?? 'none'}, generated ${plan.hash}`,
  );

  if (argv.submitDeployer) {
    for (const chainPlan of plan.chains) {
      if (chainPlan.calls.deployer.length === 0) continue;
      await new SignerMultiSend(
        multiProvider,
        chainPlan.chain,
      ).sendTransactions(chainPlan.calls.deployer.map(toCallData));
    }
    await verifyExecutedCalls(plan, multiProvider);
  }

  if (argv.proposeSafe) {
    for (const chainPlan of plan.chains) {
      if (chainPlan.calls.safe.length === 0) continue;
      assert(
        chainPlan.sources.safe,
        `[${chainPlan.chain}] missing source Safe`,
      );
      const safeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        chainPlan.chain,
        chainPlan.sources.safe,
      );
      const hashes = await safeMultiSend.sendTransactions(
        chainPlan.calls.safe.map(toCallData),
      );
      rootLogger.info(
        `[${chainPlan.chain}] proposed Safe transaction(s): ${hashes.join(', ')}`,
      );
    }

    const remoteCalls: CallData[] = [];
    for (const chainPlan of plan.chains) {
      if (chainPlan.icaCall) remoteCalls.push(toCallData(chainPlan.icaCall));
    }

    if (remoteCalls.length > 0) {
      const originSafeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        config.governance.origin,
        governanceSafe,
      );
      const hashes = await originSafeMultiSend.sendTransactions(remoteCalls);
      rootLogger.info(
        `Proposed origin Safe transaction(s): ${hashes.join(', ')}`,
      );
    }
  }

  for (const chainPlan of plan.chains) {
    if (hasPlannedCalls(chainPlan)) {
      rootLogger.info(
        `[${chainPlan.chain}] rerun after Safe execution to verify the final state`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    rootLogger.error(error);
    process.exit(1);
  });
}
