import { utils } from 'ethers';

import {
  CONTRACTS_PACKAGE_VERSION,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory,
  StaticAggregationHookFactory__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainName,
  ContractVerificationInput,
  ContractVerifier,
  MultiProvider,
  OnchainHookType,
  submitRoutingHookConfigs,
  verificationUtils,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  Logger,
  ProtocolType,
  addBufferToGasLimit,
  assert,
  concurrentMap,
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import {
  assertChildrenPreserved,
  chunkRoutes,
  diffRoutes,
  isFixedVersion,
} from './plan.js';
import { isStandardEvm } from './protocol.js';
import type { ChainReader } from './reader.js';
import { describeError } from './redact.js';
import type { ChainPlan, ChainState, RouteConfig } from './types.js';

const STATIC_AGGREGATION_HOOK_CONTRACT = 'StaticAggregationHook';
const STATIC_AGGREGATION_HOOK_FACTORY_CONTRACT = 'StaticAggregationHookFactory';
const SHADOW_HOOK_CONTRACT = 'FallbackDomainRoutingHook';
const AGGREGATOR_GAS_BUFFER_PERCENT = 15;
const ROUTE_READ_CONCURRENCY = 16;

export interface DeployedContract {
  address: Address;
  verificationInputs: ContractVerificationInput[];
}

export interface EnsureFactoryResult {
  address?: Address;
  version?: string;
  deployed: boolean;
  previous?: { address: Address; version: string };
}

// Everything after a deploy tx must keep the new address in the error, since
// it is the only handle to a contract that is otherwise unrecorded.
async function afterDeploy<T>(
  label: string,
  chain: ChainName,
  address: Address,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error: unknown) {
    throw new Error(
      `${label} ${address} was deployed on ${chain} but a later step failed: ${describeError(error)}`,
    );
  }
}

export async function ensureFactory(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  state: ChainState;
  plan: ChainPlan;
  adoptable?: Address;
  apply: boolean;
  protocol: ProtocolType;
  reader: ChainReader;
  onDeployed: (deployed: DeployedContract) => Promise<void>;
  logger: Logger;
}): Promise<EnsureFactoryResult> {
  const { multiProvider, chain, state, plan, protocol, reader, logger } = args;
  if (!plan.needsFactory) {
    return {
      address: state.factory.address,
      version: state.factory.version,
      deployed: false,
    };
  }

  const previous = {
    address: state.factory.address,
    version: state.factory.version,
  };
  const provider = multiProvider.getProvider(chain);

  if (args.adoptable && !eqAddress(args.adoptable, state.factory.address)) {
    const code = await provider.getCode(args.adoptable);
    if (code !== '0x') {
      const version = await reader.packageVersion(args.adoptable);
      if (isFixedVersion(version)) {
        logger.info(
          `[${chain}] adopting previously deployed factory ${args.adoptable} (${version})`,
        );
        return {
          address: args.adoptable,
          version,
          deployed: false,
          previous,
        };
      }
    }
  }

  if (!args.apply) {
    return { deployed: false, previous };
  }

  assert(
    isFixedVersion(CONTRACTS_PACKAGE_VERSION),
    `@hyperlane-xyz/core ${CONTRACTS_PACKAGE_VERSION} predates the fixed aggregation hook version; refusing to deploy a factory on ${chain}`,
  );

  const factoryContract = new StaticAggregationHookFactory__factory();
  const factory = await multiProvider.handleDeploy(chain, factoryContract, []);
  logger.info(`[${chain}] deployed factory at ${factory.address}`);

  return afterDeploy('Factory', chain, factory.address, async () => {
    if (isStandardEvm(protocol)) {
      // The factory creates its implementation first in its constructor
      // (contract nonce 1), so the address is derived and asserted below rather
      // than read first: a failed read after the deploy would lose its
      // verification input.
      const implementation = utils.getContractAddress({
        from: factory.address,
        nonce: 1,
      });
      await args.onDeployed({
        address: factory.address,
        verificationInputs: [
          verificationUtils.getContractVerificationInput({
            name: STATIC_AGGREGATION_HOOK_FACTORY_CONTRACT,
            contract: factory,
            bytecode: factoryContract.bytecode,
          }),
          {
            name: STATIC_AGGREGATION_HOOK_CONTRACT,
            address: implementation,
            constructorArguments: '',
            isProxy: true,
          },
        ],
      });

      const onchainImplementation = await factory.implementation();
      assert(
        eqAddress(onchainImplementation, implementation),
        `Deployed factory ${factory.address} on ${chain} reports implementation ${onchainImplementation}, expected ${implementation}`,
      );
    } else {
      await args.onDeployed({
        address: factory.address,
        verificationInputs: [],
      });

      const implementation = await factory.implementation();
      assert(
        !isZeroishAddress(implementation) &&
          (await provider.getCode(implementation)) !== '0x',
        `Deployed factory ${factory.address} on ${chain} reports no implementation contract`,
      );
    }
    const version = await reader.packageVersion(factory.address);
    assert(
      isFixedVersion(version),
      `Deployed factory ${factory.address} on ${chain} reports version ${version}, below the fixed aggregation hook version`,
    );
    return { address: factory.address, version, deployed: true, previous };
  });
}

export interface EnsureAggregatorResult {
  address: Address;
  deployed: boolean;
  exists: boolean;
}

async function assertAggregatorMatches(args: {
  reader: ChainReader;
  chain: ChainName;
  address: Address;
  children: Address[];
}): Promise<void> {
  const { reader, chain, address, children } = args;
  const hookType = await reader.hookType(address);
  assert(
    hookType === OnchainHookType.AGGREGATION,
    `New aggregator ${address} on ${chain} has hook type ${hookType}`,
  );
  assertChildrenPreserved(
    children,
    await reader.aggregationChildren(address),
    `New aggregator ${address} on ${chain}`,
  );
  const version = await reader.packageVersion(address);
  assert(
    isFixedVersion(version),
    `New aggregator ${address} on ${chain} reports version ${version}, below the fixed aggregation hook version`,
  );
}

// deployStaticAddressSet sorts its input, which would change the CREATE2
// address of an existing ordered child list, so the factory is called directly.
export async function ensureAggregator(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  factoryAddress: Address;
  children: Address[];
  apply: boolean;
  reader: ChainReader;
  logger: Logger;
}): Promise<EnsureAggregatorResult> {
  const { multiProvider, chain, factoryAddress, children, reader, logger } =
    args;
  const factory = StaticAggregationHookFactory__factory.connect(
    factoryAddress,
    multiProvider.getSignerOrProvider(chain),
  );
  const address = await factory['getAddress(address[])'](children);
  const code = await multiProvider.getProvider(chain).getCode(address);

  if (code !== '0x') {
    await assertAggregatorMatches({ reader, chain, address, children });
    return { address, deployed: false, exists: true };
  }
  if (!args.apply) return { address, deployed: false, exists: false };

  const overrides = multiProvider.getTransactionOverrides(chain);
  const estimatedGas = await factory.estimateGas['deploy(address[])'](
    children,
    overrides,
  );
  logger.info(`[${chain}] deploying aggregation hook at ${address}`);
  await multiProvider.handleTx(
    chain,
    factory['deploy(address[])'](children, {
      gasLimit: addBufferToGasLimit(
        estimatedGas,
        AGGREGATOR_GAS_BUFFER_PERCENT,
      ),
      ...overrides,
    }),
  );
  await assertAggregatorMatches({ reader, chain, address, children });
  return { address, deployed: true, exists: true };
}

async function readRoutes(
  reader: ChainReader,
  routingHook: Address,
  targets: RouteConfig[],
): Promise<Map<number, Address>> {
  const entries = await concurrentMap(
    ROUTE_READ_CONCURRENCY,
    targets,
    async (target): Promise<[number, Address]> => [
      target.destination,
      await reader.routedHook(routingHook, target.destination),
    ],
  );
  return new Map(entries);
}

export interface EnsureShadowResult {
  address?: Address;
  updatedRoutes: number;
  pendingRoutes?: number;
}

async function sendRoutes(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  routingHook: Address;
  routes: RouteConfig[];
  label: string;
  logger: Logger;
}): Promise<void> {
  const { multiProvider, chain, routingHook, routes, label, logger } = args;
  await submitRoutingHookConfigs({
    multiProvider,
    chain,
    routingHook: DomainRoutingHook__factory.connect(
      routingHook,
      multiProvider.getSigner(chain),
    ),
    configs: routes,
    logger,
    label,
  });
}

export async function ensureShadowRoutingHook(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  productionRoutingHook: Address;
  mailbox: Address;
  fallback: Address;
  signer: Address;
  existing?: Address;
  targets?: RouteConfig[];
  apply: boolean;
  protocol: ProtocolType;
  reader: ChainReader;
  onDeployed: (deployed: DeployedContract) => Promise<void>;
  logger: Logger;
}): Promise<EnsureShadowResult> {
  const {
    multiProvider,
    chain,
    mailbox,
    fallback,
    signer,
    protocol,
    reader,
    logger,
  } = args;
  const provider = multiProvider.getProvider(chain);

  const syncRoutes = async (address: Address): Promise<EnsureShadowResult> => {
    if (!args.targets) {
      return { address, updatedRoutes: 0 };
    }
    const current = await readRoutes(reader, address, args.targets);
    const pending = diffRoutes(current, args.targets);
    if (pending.length === 0 || !args.apply) {
      return { address, updatedRoutes: 0, pendingRoutes: pending.length };
    }
    const owner = await DomainRoutingHook__factory.connect(
      address,
      provider,
    ).owner();
    assert(
      eqAddress(owner, signer),
      `Cannot update shadow routing hook ${address} on ${chain}: signer ${signer} is not owner ${owner}`,
    );
    await sendRoutes({
      multiProvider,
      chain,
      routingHook: address,
      routes: pending,
      label: 'shadow routing hook configs',
      logger,
    });
    const after = await readRoutes(reader, address, args.targets);
    assert(
      diffRoutes(after, args.targets).length === 0,
      `Shadow routing hook ${address} on ${chain} does not match the target routes after update`,
    );
    return { address, updatedRoutes: pending.length };
  };

  if (args.existing) {
    const address = args.existing;
    assert(
      !eqAddress(address, args.productionRoutingHook),
      `Recorded shadow routing hook ${address} on ${chain} is the production routing hook`,
    );
    assert(
      (await provider.getCode(address)) !== '0x',
      `Recorded shadow routing hook ${address} on ${chain} has no code`,
    );
    const existing = FallbackDomainRoutingHook__factory.connect(
      address,
      provider,
    );
    const [hookType, existingMailbox, existingFallback] = await Promise.all([
      existing.hookType(),
      existing.mailbox(),
      existing.fallbackHook(),
    ]);
    assert(
      hookType === OnchainHookType.FALLBACK_ROUTING &&
        eqAddress(existingMailbox, mailbox) &&
        eqAddress(existingFallback, fallback),
      `Recorded shadow routing hook ${address} on ${chain} does not match the production routing hook (mailbox ${mailbox}, fallback ${fallback})`,
    );
    return syncRoutes(address);
  }

  if (!args.apply) {
    return {
      updatedRoutes: 0,
      pendingRoutes: args.targets?.filter(
        (target) => !isZeroishAddress(target.hook),
      ).length,
    };
  }

  const hookContract = new FallbackDomainRoutingHook__factory();
  const hook = await multiProvider.handleDeploy(chain, hookContract, [
    mailbox,
    signer,
    fallback,
  ]);
  logger.info(`[${chain}] deployed shadow routing hook at ${hook.address}`);
  return afterDeploy('Shadow routing hook', chain, hook.address, async () => {
    await args.onDeployed({
      address: hook.address,
      verificationInputs: isStandardEvm(protocol)
        ? [
            verificationUtils.getContractVerificationInput({
              name: SHADOW_HOOK_CONTRACT,
              contract: hook,
              bytecode: hookContract.bytecode,
            }),
          ]
        : [],
    });
    return syncRoutes(hook.address);
  });
}

// Runs after deployments are recorded: explorer calls are slow and may be
// interrupted, and a verification failure must not undo a deployment.
export async function verifyDeployed(args: {
  chain: ChainName;
  contractVerifier?: ContractVerifier;
  inputs: ContractVerificationInput[];
  logger: Logger;
}): Promise<void> {
  const { chain, contractVerifier, inputs, logger } = args;
  if (!contractVerifier) return;
  for (const input of inputs) {
    try {
      await contractVerifier.verifyContract(chain, input, logger);
    } catch (error: unknown) {
      logger.warn(
        `[${chain}] failed to verify ${input.name} ${input.address}: ${describeError(error)}`,
      );
    }
  }
}

export interface ProdRoutesResult {
  pending: number;
  sent: number;
  emitted: AnnotatedEV5Transaction[];
}

export async function applyProdRoutes(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  routingHook: Address;
  owner: Address;
  signer: Address;
  targets: RouteConfig[];
  apply: boolean;
  reader: ChainReader;
  logger: Logger;
}): Promise<ProdRoutesResult> {
  const { multiProvider, chain, routingHook, owner, signer, reader, logger } =
    args;
  const current = await readRoutes(reader, routingHook, args.targets);
  const pending = diffRoutes(current, args.targets);
  if (pending.length === 0) return { pending: 0, sent: 0, emitted: [] };

  const iface = DomainRoutingHook__factory.createInterface();
  const readOnly = DomainRoutingHook__factory.connect(
    routingHook,
    multiProvider.getProvider(chain),
  );
  for (const batch of chunkRoutes(chain, pending)) {
    await readOnly.callStatic.setHooks(batch, { from: owner });
  }
  if (!args.apply) return { pending: pending.length, sent: 0, emitted: [] };

  if (!eqAddress(owner, signer)) {
    const chainId = multiProvider.getEvmChainId(chain);
    const emitted = chunkRoutes(chain, pending).map(
      (batch): AnnotatedEV5Transaction => ({
        annotation: `Repoint ${batch.length} domain(s) to the ERC20 fee capable aggregation hook`,
        chainId,
        to: routingHook,
        data: iface.encodeFunctionData('setHooks((uint32,address)[])', [batch]),
      }),
    );
    return { pending: pending.length, sent: 0, emitted };
  }

  await sendRoutes({
    multiProvider,
    chain,
    routingHook,
    routes: pending,
    label: 'production routing hook configs',
    logger,
  });
  const after = await readRoutes(reader, routingHook, args.targets);
  assert(
    diffRoutes(after, args.targets).length === 0,
    `Routing hook ${routingHook} on ${chain} does not match the target routes after update`,
  );
  return { pending: pending.length, sent: pending.length, emitted: [] };
}
