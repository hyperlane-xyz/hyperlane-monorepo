import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  ChainTechnicalStack,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpConfig,
  IsmType,
  MerkleTreeHookConfig,
  MultisigConfig,
  MultisigIsmConfig,
  PausableHookConfig,
  PausableIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
  multisigConfigToIsmConfig,
} from '@hyperlane-xyz/sdk';
import { Address, WithAddress, assert, objMap } from '@hyperlane-xyz/utils';

import { getChain, getChainAddresses } from '../../registry.js';
import { legacyIgpChains } from '../../../src/config/chain.js';

import { getEdenCoreConfig } from './eden.js';
import { getTronCoreConfig } from './tron.js';
import { getIgp } from './igp.js';
import { DEPLOYER, PAUSER, ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

// There are no static ISMs or hooks for zkSync, this means
// that the default ISM is a routing ISM and the default hook
// is a fallback routing hook.
// Lazily builds the core config map. Deferred (and memoized) because it depends
// on the IGP config, which is itself computed lazily to keep merely importing
// the environment config cheap. See getIgp in ./igp.ts.
let coreCache: ChainMap<CoreConfig> | undefined;

// These deployed core hook trees predate the current deployer path. Keep this
// list explicit so registry availability changes cannot silently opt another
// chain into in-place recovery.
const legacyCoreHookRecoveryChains: ChainName[] = [
  'coti',
  'electroneum',
  'krown',
  'metis',
  'pulsechain',
  'sei',
  'sonic',
  'taiko',
  'viction',
];

// Metis has two live MerkleTreeHooks: its fallback routing hook points at the
// newer block-18,010,430 deployment, while its immutable aggregation hook
// still contains the older block-18,009,558 deployment. Model both addresses
// instead of substituting the registry's canonical active tree into either
// immutable position.
const legacyCoreHookTopologyOverrides: Partial<
  ChainMap<{
    fallbackMerkleTreeHook: Address;
    aggregationMerkleTreeHook: Address;
  }>
> = {
  metis: {
    fallbackMerkleTreeHook: '0x5F954cA945671e48466680eA815727948Ca340ef',
    aggregationMerkleTreeHook: '0xF5da68b2577EF5C0A0D98aA2a58483a68C2f232a',
  },
};

export function getCore(): ChainMap<CoreConfig> {
  if (coreCache) {
    return coreCache;
  }
  const igp = getIgp();
  coreCache = objMap(ethereumChainOwners, (local, owner) => {
    // eden is a special case, it's only connected to celestia.
    // Core is owned by the Celestia multisig; igp/oracle stays deployer-owned.
    if (local === 'eden') {
      return getEdenCoreConfig(igp['eden']);
    }

    // tron only has ISM/hooks for its connected chains
    if (local === 'tron') {
      return getTronCoreConfig(owner, igp['tron']);
    }

    const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
      supportedChainNames
        // no reflexivity
        .filter((chain) => chain !== local)
        // exclude forma as it's not a core chain
        .filter((chain) => chain !== 'forma')
        // exclude eden as it's only connected to celestia
        .filter((chain) => chain !== 'eden')
        .map((origin) => [origin, defaultMultisigConfigs[origin]]),
    );

    const isZksyncChain =
      getChain(local).technicalStack === ChainTechnicalStack.ZkSync;

    // zkSync uses a different ISM for the merkle root
    const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig =>
      multisigConfigToIsmConfig(
        isZksyncChain
          ? IsmType.STORAGE_MERKLE_ROOT_MULTISIG
          : IsmType.MERKLE_ROOT_MULTISIG,
        multisig,
      );

    // zkSync uses a different ISM for the message ID
    const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig =>
      multisigConfigToIsmConfig(
        isZksyncChain
          ? IsmType.STORAGE_MESSAGE_ID_MULTISIG
          : IsmType.MESSAGE_ID_MULTISIG,
        multisig,
      );

    const routingIsm: RoutingIsmConfig = {
      type: IsmType.ROUTING,
      domains: objMap(originMultisigs, (_, multisig): AggregationIsmConfig => ({
        type: IsmType.AGGREGATION,
        modules: [messageIdIsm(multisig), merkleRoot(multisig)],
        threshold: 1,
      })),
      ...owner,
    };

    // No static aggregation ISM support on zkSync
    const defaultZkSyncIsm = (): RoutingIsmConfig => ({
      type: IsmType.ROUTING,
      domains: objMap(originMultisigs, (_, multisig): MultisigIsmConfig =>
        messageIdIsm(multisig),
      ),
      ...owner,
    });

    const pausableIsm: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      paused: false,
      owner: PAUSER, // dedicated Turnkey pauser (pause solo, unpause gated)
    };

    // No static aggregation ISM support on zkSync
    const defaultIsm: AggregationIsmConfig | RoutingIsmConfig = isZksyncChain
      ? defaultZkSyncIsm()
      : {
          type: IsmType.AGGREGATION,
          modules: [routingIsm, pausableIsm],
          threshold: 2,
        };

    const merkleHook: MerkleTreeHookConfig = {
      type: HookType.MERKLE_TREE,
    };

    const igpHook = igp[local];

    const pausableHook: PausableHookConfig = {
      type: HookType.PAUSABLE,
      paused: false,
      owner: PAUSER, // dedicated Turnkey pauser (pause solo, unpause gated)
    };

    // No static aggregation hook support on zkSync
    const defaultHookDomains = objMap(
      originMultisigs,
      (_origin, _): AggregationHookConfig | IgpConfig => {
        return isZksyncChain
          ? igpHook
          : {
              type: HookType.AGGREGATION,
              hooks: [pausableHook, merkleHook, igpHook],
            };
      },
    );

    const defaultHook: FallbackRoutingHookConfig = {
      type: HookType.FALLBACK_ROUTING,
      ...owner,
      domains: defaultHookDomains,
      fallback: merkleHook,
    };

    if (typeof owner.owner !== 'string') {
      throw new Error('beneficiary must be a string');
    }

    // No aggregation hook support on zkSync, so we ignore protocolFee
    // and make the merkleTreeHook required
    const requiredHook: ProtocolFeeHookConfig | MerkleTreeHookConfig =
      isZksyncChain
        ? {
            type: HookType.MERKLE_TREE,
          }
        : {
            type: HookType.PROTOCOL_FEE,
            maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
            protocolFee: BigNumber.from(0).toString(), // 0 wei
            beneficiary: owner.owner as Address, // Owner can be AccountConfig
            ...owner,
          };

    if (legacyIgpChains.includes(local)) {
      const addresses = getChainAddresses()[local];
      const requiredHookAddress = isZksyncChain
        ? addresses?.merkleTreeHook
        : addresses?.protocolFee;
      assert(
        isZksyncChain || addresses?.pausableIsm,
        `Missing pausable ISM for ${local}`,
      );
      assert(
        addresses?.fallbackRoutingHook,
        `Missing default hook for ${local}`,
      );
      assert(requiredHookAddress, `Missing required hook for ${local}`);

      // Some legacy chains do not support PUSH0/Cancun bytecode. Reuse
      // existing hooks and the pausable ISM while still allowing routing/static
      // ISMs to be deployed and configured from the current validator config.
      const recoveredPausableIsm: WithAddress<PausableIsmConfig> = {
        ...pausableIsm,
        address: addresses.pausableIsm,
      };

      // Legacy chains outside the reviewed recovery set keep referencing the
      // existing fallback routing hook opaquely by address.
      let defaultHook: HookConfig = addresses.fallbackRoutingHook;
      if (legacyCoreHookRecoveryChains.includes(local)) {
        assert(
          addresses?.aggregationHook,
          `Missing aggregation hook for ${local}`,
        );
        assert(addresses?.pausableHook, `Missing pausable hook for ${local}`);
        assert(
          addresses?.interchainGasPaymaster,
          `Missing interchain gas paymaster for ${local}`,
        );
        assert(
          addresses?.merkleTreeHook,
          `Missing merkle tree hook for ${local}`,
        );

        const recoveredPausableHook: WithAddress<PausableHookConfig> = {
          ...pausableHook,
          address: addresses.pausableHook,
        };
        const hookTopology = legacyCoreHookTopologyOverrides[local];
        // Derivable reference to the existing fallback routing hook tree, so
        // that core apply/check traverses the nested pausable hook (now owned
        // by the pauser) and reconciles it in place instead of redeploying
        // hooks this chain cannot run. The on-chain aggregation child order
        // varies per chain; comparison and reconciliation are
        // order-insensitive. Preserve the fallback hook by its actual enrolled
        // address; it can differ from the registry's canonical MerkleTreeHook.
        defaultHook = {
          type: HookType.FALLBACK_ROUTING,
          // Preserve the existing legacy routing-hook owner. AW-739 only
          // rotates the nested PAUSABLE module to the dedicated pauser.
          owner: DEPLOYER,
          address: addresses.fallbackRoutingHook,
          fallback:
            hookTopology?.fallbackMerkleTreeHook ?? addresses.merkleTreeHook,
          domains: objMap(
            originMultisigs,
            (): WithAddress<AggregationHookConfig> => ({
              type: HookType.AGGREGATION,
              address: addresses.aggregationHook,
              hooks: [
                recoveredPausableHook,
                addresses.interchainGasPaymaster,
                hookTopology?.aggregationMerkleTreeHook ??
                  addresses.merkleTreeHook,
              ],
            }),
          ),
        };
      }

      return {
        defaultIsm: isZksyncChain
          ? defaultIsm
          : {
              type: IsmType.AGGREGATION,
              modules: [routingIsm, recoveredPausableIsm],
              threshold: 2,
            },
        defaultHook,
        requiredHook: requiredHookAddress,
        deployQuotedCalls: false,
        ...owner,
      };
    }

    return {
      defaultIsm,
      defaultHook,
      requiredHook,
      ...owner,
    };
  });
  return coreCache;
}
