import { BigNumber, ethers, utils } from 'ethers';

import {
  AbstractStorageMultisigIsm__factory,
  AmountRoutingIsm__factory,
  BlacklistIsm__factory,
  CCIPIsm__factory,
  DefaultIsm__factory,
  DelayedFlowRouterHookIsm__factory,
  DomainRoutingIsm__factory,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  IRoutingIsm__factory,
  MailboxClient__factory,
  NetFlowRateLimitedHookIsm__factory,
  OPStackIsm__factory,
  PausableIsm__factory,
  RateLimitedIsm__factory,
  StaticAggregationIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  deepEquals,
  eqAddress,
  formatMessage,
  messageId,
  normalizeAddress,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getChainNameFromCCIPSelector } from '../ccip/utils.js';
import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { OnchainHookType } from '../hook/types.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';
import { canonicalizeRemoteIsms, normalizeConfig } from '../utils/ism.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import { normalizeBlacklistedIds, readBlacklistedIds } from './blacklist.js';
import { readDelayedFlowEnrollments } from './delayedFlow.js';
import {
  DomainRoutingIsmConfig,
  InterchainAccountRouterIsm,
  IsmConfig,
  IsmType,
  ModuleType,
  RoutingIsmConfig,
  RoutingIsmDelta,
  STATIC_ISM_TYPES,
  ismTypeToModuleType,
} from './types.js';

const logger = rootLogger.child({ module: 'IsmUtils' });

// Determines the domains to enroll and unenroll to update the current ISM config
// to match the target ISM config.
export function calculateDomainRoutingDelta(
  current: DomainRoutingIsmConfig,
  target: DomainRoutingIsmConfig,
): {
  domainsToEnroll: ChainName[];
  domainsToUnenroll: ChainName[];
  domainsToUpdate: ChainName[];
} {
  const domainsToEnroll = [];
  const domainsToUpdate = [];
  for (const origin of Object.keys(target.domains)) {
    if (!current.domains[origin]) {
      domainsToEnroll.push(origin);
    } else {
      const subModuleMatches = deepEquals(
        current.domains[origin],
        target.domains[origin],
      );
      if (!subModuleMatches) {
        domainsToEnroll.push(origin);
        domainsToUpdate.push(origin);
      }
    }
  }

  const domainsToUnenroll = Object.keys(current.domains).reduce(
    (acc, origin) => {
      if (!Object.keys(target.domains).includes(origin)) {
        acc.push(origin);
      }
      return acc;
    },
    [] as ChainName[],
  );

  domainsToUpdate.push(...domainsToUnenroll);

  return {
    domainsToEnroll,
    domainsToUnenroll,
    domainsToUpdate,
  };
}

/*
 * The following functions are considered legacy and are deprecated. DO NOT USE.
 * -----------------------------------------------------------------------------
 */

// `addressToBytes` rejects the all-zero address, so the sample message used by
// `moduleCanCertainlyVerify` uses this minimal non-zero placeholder for its
// sender/recipient.
export const SAMPLE_VERIFY_ADDRESS =
  '0x0000000000000000000000000000000000000001';

// Note that this function may return false negatives, but should
// not return false positives.
// This can happen if, for example, the module has sender, recipient, or
// body specific logic, as the sample message used when querying the ISM
// uses a placeholder sender/recipient and an empty body.
export async function moduleCanCertainlyVerify(
  destModule: Address | IsmConfig,
  multiProvider: MultiProvider,
  origin: ChainName,
  destination: ChainName,
): Promise<boolean> {
  const originDomainId = multiProvider.tryGetDomainId(origin);
  const destinationDomainId = multiProvider.tryGetDomainId(destination);
  if (!originDomainId || !destinationDomainId) {
    return false;
  }
  const message = formatMessage(
    0,
    0,
    originDomainId,
    SAMPLE_VERIFY_ADDRESS,
    destinationDomainId,
    SAMPLE_VERIFY_ADDRESS,
    '0x',
  );
  const provider = multiProvider.getSignerOrProvider(destination);

  if (typeof destModule === 'string') {
    const module = IInterchainSecurityModule__factory.connect(
      destModule,
      provider,
    );

    try {
      const moduleType = await module.moduleType();
      if (
        moduleType === ModuleType.MERKLE_ROOT_MULTISIG ||
        moduleType === ModuleType.MESSAGE_ID_MULTISIG
      ) {
        const multisigModule = IMultisigIsm__factory.connect(
          destModule,
          provider,
        );

        const [, threshold] =
          await multisigModule.validatorsAndThreshold(message);
        return threshold > 0;
      } else if (moduleType === ModuleType.ROUTING) {
        const routingIsm = IRoutingIsm__factory.connect(destModule, provider);
        const subModule = await routingIsm.route(message);
        return moduleCanCertainlyVerify(
          subModule,
          multiProvider,
          origin,
          destination,
        );
      } else if (moduleType === ModuleType.AGGREGATION) {
        const aggregationIsm = IAggregationIsm__factory.connect(
          destModule,
          provider,
        );
        const [subModules, threshold] =
          await aggregationIsm.modulesAndThreshold(message);
        let verified = 0;
        for (const subModule of subModules) {
          const canVerify = await moduleCanCertainlyVerify(
            subModule,
            multiProvider,
            origin,
            destination,
          );
          if (canVerify) {
            verified += 1;
          }
        }
        return verified >= threshold;
      } else {
        throw new Error(`Unsupported module type: ${moduleType}`);
      }
    } catch (err) {
      logger.error(`Error checking module ${destModule}`, err);
      return false;
    }
  } else {
    // destModule is an IsmConfig
    switch (destModule.type) {
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        return destModule.threshold > 0;
      case IsmType.ROUTING: {
        const checking = moduleCanCertainlyVerify(
          destModule.domains[destination],
          multiProvider,
          origin,
          destination,
        );
        return checking;
      }
      case IsmType.AGGREGATION: {
        let verified = 0;
        for (const subModule of destModule.modules) {
          const canVerify = await moduleCanCertainlyVerify(
            subModule,
            multiProvider,
            origin,
            destination,
          );
          if (canVerify) {
            verified += 1;
          }
        }
        return verified >= destModule.threshold;
      }
      case IsmType.OP_STACK:
        return destModule.nativeBridge !== ethers.constants.AddressZero;
      case IsmType.TEST_ISM: {
        return true;
      }
      case IsmType.BLACKLIST: {
        // BlacklistIsm.verify returns false for a blacklisted message ID, so
        // this helper can only guarantee verification when the sample message
        // is not itself blacklisted.
        const sampleId = messageId(message).toLowerCase();
        return !destModule.blacklistedIds.some(
          (id) => id.toLowerCase() === sampleId,
        );
      }
      case IsmType.NET_FLOW_RATE_LIMITED:
      case IsmType.DELAYED_FLOW_ROUTER:
        // Verification depends on state this helper cannot read: the flow
        // bucket's remaining capacity, and for DELAYED_FLOW_ROUTER also
        // whether `readyAt` has elapsed. This function must never return a
        // false positive, so both report "cannot verify". Consequence: an
        // aggregation containing a hybrid also reports false, because an
        // aggregation counts sub-results against its threshold. That follows
        // from the no-false-positive contract and is not a regression.
        return false;
      case IsmType.MAILBOX_DEFAULT:
        // The routed-to mailbox default ISM cannot be resolved from the config
        // alone (no address), so err toward a false negative
        return false;
      default:
        throw new Error(`Unsupported module type: ${(destModule as any).type}`);
    }
  }
}

export async function moduleMatchesConfig(
  chain: ChainName,
  moduleAddress: Address,
  config: IsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<ProxyFactoryFactories>,
  mailbox?: Address,
): Promise<boolean> {
  if (typeof config === 'string') {
    return eqAddress(moduleAddress, config);
  }

  // If the module address is zero, it can't match any object-based config.
  // The subsequent check of what moduleType it is will throw, so we fail here.
  if (eqAddress(moduleAddress, ethers.constants.AddressZero)) {
    return false;
  }

  const provider = multiProvider.getProvider(chain);
  const module = IInterchainSecurityModule__factory.connect(
    moduleAddress,
    provider,
  );
  const actualType = await module.moduleType();
  if (actualType !== ismTypeToModuleType(config.type)) return false;
  let matches = true;
  switch (config.type) {
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG: {
      // A storage multisig ism matches if validators and threshold match the config
      const storageMerkleRootMultisigIsm =
        AbstractStorageMultisigIsm__factory.connect(moduleAddress, provider);
      const [validators, threshold] =
        await storageMerkleRootMultisigIsm.validatorsAndThreshold(
          ethers.constants.AddressZero,
        );
      matches = deepEquals(
        normalizeConfig({ validators, threshold }),
        normalizeConfig({
          validators: config.validators,
          threshold: config.threshold,
        }),
      );
      break;
    }
    case IsmType.MERKLE_ROOT_MULTISIG: {
      // A MerkleRootMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.staticMerkleRootMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.MESSAGE_ID_MULTISIG: {
      // A MessageIdMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.staticMessageIdMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.AMOUNT_ROUTING: {
      const amountRoutingIsm = AmountRoutingIsm__factory.connect(
        moduleAddress,
        provider,
      );

      const [lowerIsmAddress, upperIsmAddress, threshold] = await Promise.all([
        amountRoutingIsm.lower(),
        amountRoutingIsm.upper(),
        amountRoutingIsm.threshold(),
      ]);

      const subModuleMatchesConfig = await Promise.all(
        [
          [lowerIsmAddress, config.lowerIsm],
          [upperIsmAddress, config.upperIsm],
        ].map(([ismAddress, ismConfig]) =>
          moduleMatchesConfig(
            chain,
            ismAddress as string,
            ismConfig,
            multiProvider,
            contracts,
            mailbox,
          ),
        ),
      );
      matches &&= threshold.eq(config.threshold);
      matches &&= subModuleMatchesConfig.every(Boolean);

      break;
    }
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.ROUTING: {
      // A RoutingIsm matches if:
      //   1. The set of domains in the config equals those on-chain
      //   2. The modules for each domain match the config
      // TODO: Check (1)
      const routingIsm = DomainRoutingIsm__factory.connect(
        moduleAddress,
        provider,
      );
      // Check that the RoutingISM owner matches the config
      const owner = await routingIsm.owner();
      const expectedOwner = config.owner;
      matches &&= eqAddress(owner, expectedOwner);
      // check if the mailbox matches the config for fallback routing
      if (config.type === IsmType.FALLBACK_ROUTING) {
        const client = MailboxClient__factory.connect(moduleAddress, provider);
        let mailboxAddress;
        try {
          mailboxAddress = await client.mailbox();
        } catch {
          matches = false;
          break;
        }
        matches =
          matches &&
          mailbox !== undefined &&
          eqAddress(mailboxAddress, mailbox);
      }
      const delta = await routingModuleDelta(
        chain,
        moduleAddress,
        config,
        multiProvider,
        contracts,
        mailbox,
      );
      matches =
        matches &&
        delta.domainsToEnroll.length === 0 &&
        delta.domainsToUnenroll.length === 0 &&
        !delta.mailbox &&
        !delta.owner;
      break;
    }
    case IsmType.AGGREGATION: {
      // An AggregationIsm matches if:
      //   1. The threshold matches the config
      //   2. There is a bijection between on and off-chain configured modules
      const aggregationIsm = StaticAggregationIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const [subModules, threshold] =
        await aggregationIsm.modulesAndThreshold('0x');
      matches &&= threshold === config.threshold;
      matches &&= subModules.length === config.modules.length;

      const configIndexMatched = new Map();
      for (const subModule of subModules) {
        const subModuleMatchesConfig = await Promise.all(
          config.modules.map((c) =>
            moduleMatchesConfig(
              chain,
              subModule,
              c,
              multiProvider,
              contracts,
              mailbox,
            ),
          ),
        );
        // The submodule returned by the ISM must match exactly one
        // entry in the config.
        const count = subModuleMatchesConfig.filter(Boolean).length;
        matches &&= count === 1;

        // That entry in the config should not have been matched already.
        subModuleMatchesConfig.forEach((matched, index) => {
          if (matched) {
            matches &&= !configIndexMatched.has(index);
            configIndexMatched.set(index, true);
          }
        });
      }
      break;
    }
    case IsmType.OP_STACK: {
      const opStackIsm = OPStackIsm__factory.connect(moduleAddress, provider);
      const type = await opStackIsm.moduleType();
      matches &&= type === ModuleType.NULL;
      break;
    }
    case IsmType.TEST_ISM: {
      // A NULL module type alone does not make this a Test ISM; every other
      // NULL ISM shares it. Defer to the reader, which reaches TEST_ISM only
      // after every distinguishing selector has missed, so the checker and the
      // reader classify a given address the same way.
      const derived = await new EvmIsmReader(
        multiProvider,
        chain,
      ).deriveNullConfig(moduleAddress);
      matches &&= derived.type === IsmType.TEST_ISM;
      break;
    }
    case IsmType.TRUSTED_RELAYER: {
      const trustedRelayerIsm = TrustedRelayerIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const type = await trustedRelayerIsm.moduleType();
      matches &&= type === ModuleType.NULL;
      let relayer: Address;
      try {
        relayer = await trustedRelayerIsm.trustedRelayer();
      } catch (error) {
        throwIfNotMissingSelector(error);
        return false;
      }
      matches &&= eqAddress(relayer, config.relayer);
      break;
    }
    case IsmType.CCIP: {
      const ccipIsm = CCIPIsm__factory.connect(moduleAddress, provider);
      const type = await ccipIsm.moduleType();
      matches &&= type === ModuleType.NULL;

      // Check that the origin chain selector matches the config
      const originCcipChainSelector = await ccipIsm.ccipOrigin();
      const chainName = getChainNameFromCCIPSelector(
        originCcipChainSelector.toString(),
      );
      matches &&= chainName === config.originChain;
      break;
    }
    case IsmType.PAUSABLE: {
      const pausableIsm = PausableIsm__factory.connect(moduleAddress, provider);
      const owner = await pausableIsm.owner();
      const expectedOwner = config.owner;
      matches &&= eqAddress(owner, expectedOwner);

      if (config.paused) {
        const isPaused = await pausableIsm.paused();
        matches &&= config.paused === isPaused;
      }
      break;
    }
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG: {
      const expectedAddress =
        await contracts.staticMerkleRootWeightedMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.thresholdWeight,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG: {
      const expectedAddress =
        await contracts.staticMessageIdWeightedMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.thresholdWeight,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.RATE_LIMITED: {
      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const [onChainMaxCapacity, onChainRecipient] = await Promise.all([
        rateLimitedIsm.maxCapacity(),
        rateLimitedIsm.recipient(),
      ]);
      matches &&= onChainMaxCapacity.eq(config.maxCapacity);
      if (config.recipient) {
        matches &&= eqAddress(onChainRecipient, config.recipient);
      }
      if (config.owner) {
        const onChainOwner = await rateLimitedIsm.owner();
        matches &&= eqAddress(onChainOwner, config.owner);
      }
      break;
    }
    case IsmType.BLACKLIST: {
      const blacklistIsm = BlacklistIsm__factory.connect(
        moduleAddress,
        provider,
      );

      // Detection before enumeration, the same order the reader uses. Without
      // it any Ownable NULL-type ISM whose owner happens to match would report
      // as an empty blacklist, since a missing `values()` selector falls
      // through to a log replay that finds nothing.
      let owner: Address;
      try {
        await blacklistIsm.blacklistedIds(ethers.constants.HashZero);
        owner = await blacklistIsm.owner();
      } catch (error) {
        throwIfNotMissingSelector(error);
        return false;
      }
      matches &&= eqAddress(owner, config.owner);

      // Same enumeration the reader uses, so a deployment that reads back as
      // matching here also converges to zero transactions in EvmIsmModule.
      const onChainIds = await readBlacklistedIds(
        chain,
        moduleAddress,
        multiProvider,
      );

      // Entries are append-only on-chain, so any on-chain ID missing from the
      // config makes the config unreachable: require exact set equality.
      matches &&= deepEquals(
        onChainIds,
        normalizeBlacklistedIds(config.blacklistedIds),
      );
      break;
    }
    case IsmType.MAILBOX_DEFAULT: {
      // A DefaultIsm matches if it defers to the expected mailbox
      const defaultIsm = DefaultIsm__factory.connect(moduleAddress, provider);
      const onChainMailbox = await defaultIsm.mailbox();
      matches = mailbox !== undefined && eqAddress(onChainMailbox, mailbox);
      break;
    }
    case IsmType.NET_FLOW_RATE_LIMITED: {
      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        moduleAddress,
        provider,
      );
      let onChainHookType: number;
      try {
        onChainHookType = await netFlowIsm.hookType();
      } catch (error) {
        throwIfNotMissingSelector(error);
        return false;
      }
      if (onChainHookType !== OnchainHookType.RATE_LIMITED) return false;

      const [onChainWarpRouter, onChainThresholdBps, onChainDuration] =
        await Promise.all([
          netFlowIsm.warpRouter(),
          netFlowIsm.thresholdBps(),
          netFlowIsm.DURATION(),
        ]);
      if (config.warpRouter) {
        matches &&= eqAddress(onChainWarpRouter, config.warpRouter);
      }
      matches &&= onChainThresholdBps.eq(config.thresholdBps);
      matches &&= onChainDuration.toBigInt() === BigInt(config.duration);
      if (config.owner) {
        const onChainOwner = await netFlowIsm.owner();
        matches &&= eqAddress(onChainOwner, config.owner);
      }
      break;
    }
    case IsmType.DELAYED_FLOW_ROUTER: {
      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        moduleAddress,
        provider,
      );
      let onChainConfig: [Address, BigNumber, number, BigNumber, Address];
      try {
        onChainConfig = await Promise.all([
          delayedIsm.warpRouter(),
          delayedIsm.thresholdBps(),
          delayedIsm.maxDelay(),
          delayedIsm.DURATION(),
          delayedIsm.owner(),
        ]);
      } catch (error) {
        throwIfNotMissingSelector(error);
        return false;
      }
      const [
        onChainWarpRouter,
        onChainThresholdBps,
        onChainMaxDelay,
        onChainDuration,
        onChainOwner,
      ] = onChainConfig;
      if (config.warpRouter) {
        matches &&= eqAddress(onChainWarpRouter, config.warpRouter);
      }
      matches &&= onChainThresholdBps.eq(config.thresholdBps);
      matches &&= onChainMaxDelay === config.maxDelay;
      matches &&= onChainDuration.toBigInt() === BigInt(config.duration);
      matches &&= eqAddress(onChainOwner, config.owner);
      if (matches && config.remoteIsms !== undefined) {
        // Strict set equality between configured and enrolled counterparts,
        // scoped by the same chain<->domain resolution the reader uses so that
        // a derived config always matches the instance it was derived from.
        const { named, unnamedDomains } = await readDelayedFlowEnrollments(
          delayedIsm,
          multiProvider,
          multiProvider.tryGetRpcConcurrency(chain) ??
            DEFAULT_CONTRACT_READ_CONCURRENCY,
          logger,
        );
        if (unnamedDomains.length > 0) {
          // No config can name these, so they can never be an expected
          // enrollment — and an enrolled counterpart may preverify arbitrary
          // message ids, so they must not be invisible to `warp check`.
          logger.warn(
            `DelayedFlowRouterHookIsm at ${moduleAddress} on ${chain} has enrollments on unnameable domain(s) ${unnamedDomains.join(', ')}, which no config can express`,
          );
        }
        matches &&= unnamedDomains.length === 0;
        const enrolledByChain = new Map(
          named.map(({ chainName, router }) => [chainName, router]),
        );
        // Same canonical representation the deploy and update paths use, so a
        // config keyed by domain id compares against the enrollment it
        // actually describes instead of always reading as drift.
        const configEntries = Object.entries(
          canonicalizeRemoteIsms(
            config.remoteIsms,
            multiProvider,
            `DelayedFlowRouterHookIsm at ${moduleAddress} on ${chain}`,
          ),
        );
        matches &&= named.length === configEntries.length;
        for (const [chainName, router] of configEntries) {
          if (!matches) break;
          matches &&= enrolledByChain.get(chainName) === router;
        }
      }
      break;
    }
    default: {
      throw new Error('Unsupported ModuleType');
    }
  }

  return matches;
}

export async function routingModuleDelta(
  destination: ChainName,
  moduleAddress: Address,
  config: RoutingIsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<ProxyFactoryFactories>,
  mailbox?: Address,
): Promise<RoutingIsmDelta> {
  if (
    config.type === IsmType.FALLBACK_ROUTING ||
    config.type === IsmType.ROUTING ||
    config.type === IsmType.INCREMENTAL_ROUTING
  ) {
    return domainRoutingModuleDelta(
      destination,
      moduleAddress,
      config,
      multiProvider,
      contracts,
      mailbox,
    );
  }

  return {
    domainsToEnroll: [],
    domainsToUnenroll: [],
  };
}

async function domainRoutingModuleDelta(
  destination: ChainName,
  moduleAddress: Address,
  config: DomainRoutingIsmConfig | InterchainAccountRouterIsm,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<ProxyFactoryFactories>,
  mailbox?: Address,
): Promise<RoutingIsmDelta> {
  const provider = multiProvider.getProvider(destination);
  const routingIsm = DomainRoutingIsm__factory.connect(moduleAddress, provider);
  const owner = await routingIsm.owner();
  const deployedDomains = (await routingIsm.domains()).map((domain) =>
    domain.toNumber(),
  );

  const delta: RoutingIsmDelta = {
    domainsToUnenroll: [],
    domainsToEnroll: [],
  };

  // if owners don't match, we need to transfer ownership
  if (!eqAddress(owner, normalizeAddress(config.owner))) {
    delta.owner = config.owner;
  }

  if (config.type === IsmType.FALLBACK_ROUTING) {
    const client = MailboxClient__factory.connect(moduleAddress, provider);
    const mailboxAddress = await client.mailbox();
    if (mailbox && !eqAddress(mailboxAddress, mailbox)) delta.mailbox = mailbox;
  }

  const ismByDomainName =
    config.type === IsmType.INTERCHAIN_ACCOUNT_ROUTING
      ? config.isms
      : config.domains;

  // config.domains is already filtered to only include domains in the multiprovider
  const safeConfigDomains = objMap(ismByDomainName, (chainName) =>
    multiProvider.getDomainId(chainName),
  );

  // check for exclusion of domains in the config
  // Note: Incremental routing ISMs don't support domain removal, so skip unenroll
  if (config.type !== IsmType.INCREMENTAL_ROUTING) {
    delta.domainsToUnenroll = deployedDomains.filter(
      (domain) => !Object.values(safeConfigDomains).includes(domain),
    );
  }
  // check for inclusion of domains in the config
  for (const [origin, subConfig] of Object.entries(ismByDomainName)) {
    const originDomain = safeConfigDomains[origin];
    if (!deployedDomains.includes(originDomain)) {
      delta.domainsToEnroll.push(originDomain);
    } else {
      const subModule = await routingIsm.module(originDomain);
      // Recursively check that the submodule for each configured
      // domain matches the submodule config.
      const subModuleMatches = await moduleMatchesConfig(
        destination,
        subModule,
        subConfig,
        multiProvider,
        contracts,
        mailbox,
      );
      if (!subModuleMatches) {
        delta.domainsToEnroll.push(originDomain);
      }
    }
  }

  return delta;
}

export function collectValidators(
  origin: ChainName,
  config: IsmConfig,
): Set<string> {
  // TODO: support address configurations in collectValidators
  if (typeof config === 'string') {
    logger
      .child({ origin })
      .debug('Address config unimplemented in collectValidators');
    return new Set([]);
  }

  let validators: string[] = [];
  if (
    config.type === IsmType.STORAGE_MERKLE_ROOT_MULTISIG ||
    config.type === IsmType.STORAGE_MESSAGE_ID_MULTISIG ||
    config.type === IsmType.MERKLE_ROOT_MULTISIG ||
    config.type === IsmType.MESSAGE_ID_MULTISIG
  ) {
    validators = config.validators;
  } else if (config.type === IsmType.ROUTING) {
    if (Object.keys(config.domains).includes(origin)) {
      const domainValidators = collectValidators(
        origin,
        config.domains[origin],
      );
      validators = [...domainValidators];
    }
  } else if (config.type === IsmType.AGGREGATION) {
    const aggregatedValidators = config.modules.map((c) =>
      collectValidators(origin, c),
    );
    aggregatedValidators.forEach((set) => {
      validators = validators.concat([...set]);
    });
  } else if (
    config.type === IsmType.TEST_ISM ||
    config.type === IsmType.PAUSABLE
  ) {
    return new Set([]);
  } else {
    throw new Error('Unsupported ModuleType');
  }

  return new Set(validators);
}

/**
 * Checks if the given ISM type requires static deployment
 *
 * @param {IsmType} ismType - The type of Interchain Security Module (ISM)
 * @returns {boolean} True if the ISM type requires static deployment, false otherwise
 */
export function isStaticIsm(ismType: IsmType): boolean {
  return STATIC_ISM_TYPES.includes(ismType);
}

/**
 * Determines if static ISM deployment is supported on a given chain's technical stack
 * @dev Currently, only ZkSync does not support static deployments
 * @param chainTechnicalStack - The technical stack of the target chain
 * @returns boolean - true if static deployment is supported, false for ZkSync
 */
export function isStaticDeploymentSupported(
  chainTechnicalStack: ChainTechnicalStack | undefined,
): boolean {
  return chainTechnicalStack !== ChainTechnicalStack.ZkSync;
}

/**
 * Checks if the given ISM type is compatible with the chain's technical stack.
 *
 * @param {IsmType} params.ismType - The type of Interchain Security Module (ISM)
 * @param {ChainTechnicalStack | undefined} params.chainTechnicalStack - The technical stack of the chain
 * @returns {boolean} True if the ISM type is compatible with the chain, false otherwise
 */
export function isIsmCompatible({
  chainTechnicalStack,
  ismType,
}: {
  chainTechnicalStack: ChainTechnicalStack | undefined;
  ismType: IsmType;
}): boolean {
  // Skip compatibility check for non-static ISMs as they're always supported
  if (!isStaticIsm(ismType)) return true;
  return isStaticDeploymentSupported(chainTechnicalStack);
}

export function offchainLookupRequestMessageHash(
  sender: string,
  callData: string,
  urlTemplate: string,
): string {
  return utils.solidityKeccak256(
    ['string', 'address', 'bytes', 'string'],
    ['HYPERLANE_OFFCHAINLOOKUP', sender, callData, urlTemplate],
  );
}
