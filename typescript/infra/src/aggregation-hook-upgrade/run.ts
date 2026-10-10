import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { ChainName, ContractVerificationInput } from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  concurrentMap,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { Modules } from '../../scripts/agent-utils.js';
import { DEPLOYERS, Owner, determineGovernanceType } from '../governance.js';

import type {
  ChainExportUpdate,
  ExportedAggregator,
  ExportedFactory,
} from './address-export.js';
import { readChainState } from './discovery.js';
import { checkEligibility } from './eligibility.js';
import {
  applyProdRoutes,
  ensureAggregator,
  ensureFactory,
  ensureShadowRoutingHook,
  verifyDeployed,
} from './execute.js';
import { buildProdTargets, buildShadowTargets, planChain } from './plan.js';
import { isStandardEvm } from './protocol.js';
import { createEvmChainReader } from './reader.js';
import { describeError } from './redact.js';
import { RegistryAddressUpdate, buildRegistryAddresses } from './registry.js';
import {
  ChainOutcome,
  ChainPlan,
  ChainResult,
  ChainState,
  DomainCoverage,
  UpgradeContext,
  UpgradePhase,
} from './types.js';

function buildCoverage(state: ChainState, plan: ChainPlan): DomainCoverage {
  return {
    universe: state.routes.length + state.unmapped.length,
    mapped: state.routes.length,
    fixed: plan.fixedRoutes,
    legacy: plan.migrations.length,
    unmapped: state.unmapped.map((domain) => domain.chain),
    nonAggregation: plan.nonAggregation.map((route) => ({
      chain: route.domain.chain,
      hook: route.hook,
    })),
    ignoredMapped: state.ignored.mapped,
    ignoredLegacy: state.ignored.legacyAggregator,
  };
}

async function runChain(
  ctx: UpgradeContext,
  chain: ChainName,
): Promise<ChainResult> {
  const { multiProvider, logger } = ctx;
  const result: ChainResult = {
    chain,
    outcome: ChainOutcome.UpToDate,
    aggregators: [],
    verificationRecoveryFiles: [],
    registryKeysWritten: [],
    pending: [],
  };

  const metadata = multiProvider.getChainMetadata(chain);
  const addresses = ctx.chainAddresses[chain];
  const eligibility = checkEligibility(
    {
      chain,
      protocol: metadata.protocol,
      technicalStack: metadata.technicalStack,
      addresses,
    },
    ctx.skipLists,
  );
  if (!eligibility.eligible) {
    result.outcome = ChainOutcome.Skipped;
    result.skipReason = eligibility.reason;
    result.detail = eligibility.detail;
    return result;
  }
  assert(addresses, `Missing registry addresses for ${chain}`);

  const reader = createEvmChainReader(multiProvider.getProvider(chain), logger);
  const read = await readChainState({
    chain,
    originDomainId: multiProvider.getDomainId(chain),
    mailbox: eligibility.mailbox,
    factory: eligibility.factory,
    registryAggregationHook: addresses.aggregationHook,
    supportedDomains: ctx.supportedDomains,
    registryDomainIds: ctx.registryDomainIds,
    reader,
    concurrency: ctx.probeConcurrency,
  });
  if (!('state' in read)) {
    result.outcome = ChainOutcome.Skipped;
    result.skipReason = read.skip;
    result.detail = read.detail;
    return result;
  }

  const { state } = read;
  const plan = planChain(state, ctx.phase);
  result.coverage = buildCoverage(state, plan);
  result.owner = state.routingOwner;
  const governance = await determineGovernanceType(chain, state.routingOwner);
  result.ownerType = governance.ownerType ?? Owner.UNKNOWN;
  const existingExport = await ctx.persist.exportStore.read(chain);
  const recordedShadow =
    ctx.phase === UpgradePhase.Shadow
      ? existingExport?.shadowRoutingHook
      : undefined;
  if (plan.upToDate && recordedShadow === undefined) return result;

  const signer = ctx.apply
    ? await multiProvider.getSignerAddress(chain)
    : DEPLOYERS[ctx.environment];

  if (ctx.apply && !isStandardEvm(metadata.protocol)) {
    logger.info(
      `[${chain}] contract verification is not supported for ${metadata.protocol}; verification inputs are not recorded`,
    );
  }

  const factoryInputs: ContractVerificationInput[] = [];
  const hookInputs: ContractVerificationInput[] = [];
  const exportedAggregators: ExportedAggregator[] = [];
  let exportedFactory: ExportedFactory & { previous?: ExportedFactory } = {
    address: state.factory.address,
    version: state.factory.version,
  };
  let shadowRoutingHook: Address | undefined;
  let currentAddresses = addresses;
  let changed = false;
  let emitted = false;

  const writeRegistry = (update: RegistryAddressUpdate) => {
    currentAddresses = buildRegistryAddresses(currentAddresses, update);
    ctx.persist.writeRegistryAddresses(chain, currentAddresses);
    result.registryKeysWritten.push(...Object.keys(update));
    changed = true;
  };

  const recordExport = async () => {
    if (!ctx.apply || plan.upToDate) return;
    const update: ChainExportUpdate = {
      signer,
      phase: ctx.phase,
      routingHook: state.routingHook,
      routingHookOwner: state.routingOwner,
      routingHookOwnerType: result.ownerType ?? Owner.UNKNOWN,
      factory: exportedFactory,
      aggregators: exportedAggregators,
    };
    if (shadowRoutingHook) update.shadowRoutingHook = shadowRoutingHook;
    await ctx.persist.exportStore.update(chain, update, ctx.now());
  };

  const persistInputs = async (
    module: Modules,
    inputs: ContractVerificationInput[],
  ) => {
    if (!ctx.apply || inputs.length === 0) return;
    try {
      await ctx.persist.writeVerificationInputs(module, { [chain]: inputs });
    } catch (error: unknown) {
      logger.error(
        `[${chain}] failed to persist ${module} verification inputs: ${describeError(error)}`,
      );
      const file = await ctx.persist.writeVerificationRecovery(
        module,
        chain,
        inputs,
      );
      logger.warn(`[${chain}] saved ${module} verification inputs to ${file}`);
      if (!result.verificationRecoveryFiles.includes(file)) {
        result.verificationRecoveryFiles.push(file);
      }
    }
  };

  try {
    const factoryResult = await ensureFactory({
      multiProvider,
      chain,
      state,
      plan,
      adoptable: existingExport?.factory.address,
      apply: ctx.apply,
      protocol: metadata.protocol,
      reader,
      onDeployed: async ({ address, verificationInputs }) => {
        factoryInputs.push(...verificationInputs);
        exportedFactory = {
          address,
          version: CONTRACTS_PACKAGE_VERSION,
          previous: {
            address: state.factory.address,
            version: state.factory.version,
          },
        };
        result.factory = {
          address,
          previous: state.factory.address,
          deployed: true,
        };
        changed = true;
        await recordExport();
        await persistInputs(Modules.PROXY_FACTORY, verificationInputs);
        writeRegistry({ staticAggregationHookFactory: address });
      },
      logger,
    });
    const factoryAddress = factoryResult.address;
    result.factory = {
      address: factoryAddress,
      previous: factoryResult.previous?.address,
      deployed: factoryResult.deployed,
    };
    if (factoryAddress && factoryResult.version) {
      exportedFactory = {
        address: factoryAddress,
        version: factoryResult.version,
      };
      if (factoryResult.previous)
        exportedFactory.previous = factoryResult.previous;
      if (
        ctx.apply &&
        !factoryResult.deployed &&
        !eqAddress(factoryAddress, state.factory.address)
      ) {
        writeRegistry({ staticAggregationHookFactory: factoryAddress });
      }
      await recordExport();
    } else {
      result.pending.push(
        `deploy a StaticAggregationHookFactory (current ${state.factory.address} is ${state.factory.version})`,
      );
    }

    const aggregatorByKey = new Map<string, Address>();
    let aggregatorsKnown = true;
    for (const set of plan.sets) {
      if (!factoryAddress) {
        aggregatorsKnown = false;
        result.aggregators.push({
          children: set.children,
          replaces: set.replaces,
          deployed: false,
        });
        continue;
      }
      const aggregator = await ensureAggregator({
        multiProvider,
        chain,
        factoryAddress,
        children: set.children,
        apply: ctx.apply,
        reader,
        logger,
      });
      aggregatorByKey.set(set.key, aggregator.address);
      result.aggregators.push({
        children: set.children,
        replaces: set.replaces,
        address: aggregator.address,
        deployed: aggregator.deployed,
      });
      if (aggregator.deployed) changed = true;
      if (!aggregator.exists) {
        result.pending.push(`deploy aggregation hook ${aggregator.address}`);
      }
      if (ctx.apply) {
        exportedAggregators.push({
          children: set.children,
          address: aggregator.address,
          replaces: set.replaces,
        });
      }
    }
    if (!aggregatorsKnown) {
      result.pending.push(`deploy ${plan.sets.length} aggregation hook(s)`);
    }
    await recordExport();

    if (
      ctx.phase === UpgradePhase.Shadow &&
      (plan.migrations.length > 0 || recordedShadow !== undefined)
    ) {
      const shadow = await ensureShadowRoutingHook({
        multiProvider,
        chain,
        productionRoutingHook: state.routingHook,
        mailbox: state.mailbox,
        fallback: state.routingFallback,
        signer,
        existing: recordedShadow,
        targets: aggregatorsKnown
          ? buildShadowTargets(state, plan, aggregatorByKey)
          : undefined,
        apply: ctx.apply,
        protocol: metadata.protocol,
        reader,
        onDeployed: async ({ address, verificationInputs }) => {
          hookInputs.push(...verificationInputs);
          shadowRoutingHook = address;
          result.shadowRoutingHook = address;
          changed = true;
          await recordExport();
          await persistInputs(Modules.HOOK, verificationInputs);
        },
        logger,
      });
      shadowRoutingHook = shadow.address;
      result.shadowRoutingHook = shadow.address;
      if (shadow.updatedRoutes > 0) changed = true;
      if (!shadow.address) {
        result.pending.push('deploy a shadow FallbackDomainRoutingHook');
      }
      if (shadow.pendingRoutes) {
        result.pending.push(
          `update ${shadow.pendingRoutes} route(s) on the shadow routing hook`,
        );
      }
      await recordExport();
    }

    if (ctx.phase === UpgradePhase.Prod) {
      let converged = ctx.apply;
      if (plan.migrations.length > 0) {
        if (aggregatorsKnown) {
          const prod = await applyProdRoutes({
            multiProvider,
            chain,
            routingHook: state.routingHook,
            owner: state.routingOwner,
            signer,
            targets: buildProdTargets(plan, aggregatorByKey),
            apply: ctx.apply,
            reader,
            logger,
          });
          result.setHooks = {
            migrate: plan.migrations.length,
            sent: prod.sent,
            emitted: prod.emitted.length,
          };
          if (prod.sent > 0) changed = true;
          if (prod.emitted.length > 0) {
            result.txFile = await ctx.persist.writeTransactions(
              chain,
              prod.emitted,
            );
            emitted = true;
          }
          converged = ctx.apply && prod.emitted.length === 0;
          if (!ctx.apply && prod.pending > 0) {
            result.pending.push(
              `${eqAddress(state.routingOwner, signer) ? 'send' : 'emit'} setHooks for ${prod.pending} domain(s)`,
            );
          }
        } else {
          converged = false;
          result.pending.push(
            `setHooks for ${plan.migrations.length} domain(s) after the aggregation hooks exist`,
          );
        }
      }
      if (plan.registryAggregationKey !== undefined) {
        const aggregationHook = aggregatorByKey.get(
          plan.registryAggregationKey,
        );
        if (converged && aggregationHook) {
          writeRegistry({ aggregationHook });
        } else if (!ctx.apply) {
          result.pending.push('update registry aggregationHook');
        }
      }
    }

    if (!ctx.apply) {
      result.outcome =
        result.pending.length > 0
          ? ChainOutcome.Planned
          : ChainOutcome.UpToDate;
    } else if (emitted) {
      result.outcome = ChainOutcome.Emitted;
    } else {
      result.outcome = changed ? ChainOutcome.Applied : ChainOutcome.UpToDate;
    }
    if (result.verificationRecoveryFiles.length > 0) {
      result.outcome = ChainOutcome.Error;
      result.detail = `deployed, but verification inputs were not persisted; saved to ${result.verificationRecoveryFiles.join(', ')}`;
    }
    return result;
  } finally {
    if (ctx.apply) {
      await verifyDeployed({
        chain,
        contractVerifier: ctx.contractVerifier,
        inputs: [...factoryInputs, ...hookInputs],
        logger,
      });
    }
  }
}

export async function runUpgrade(
  ctx: UpgradeContext,
  chains: ChainName[],
): Promise<ChainResult[]> {
  return concurrentMap(ctx.concurrency, chains, async (chain) => {
    try {
      return await runChain(ctx, chain);
    } catch (error: unknown) {
      const detail = describeError(error);
      ctx.logger.error(`[${chain}] ${detail}`);
      const failed: ChainResult = {
        chain,
        outcome: ChainOutcome.Error,
        detail,
        aggregators: [],
        verificationRecoveryFiles: [],
        registryKeysWritten: [],
        pending: [],
      };
      return failed;
    }
  });
}
