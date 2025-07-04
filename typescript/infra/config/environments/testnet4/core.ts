import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  ChainTechnicalStack,
  CoreConfig,
  FallbackRoutingHookConfig,
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
import { Address, objMap } from '@hyperlane-xyz/utils';

import { getChain } from '../../registry.js';

import { igp } from './igp.js';
import { ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

// Rome Testnet is an EVM within an SVM, and so the gas metering is vastly different to vanilla EVM.
// Owing to this, the gas usage numbers are 10-12x higher due to the different metering.
// This means that we can only selectively connect Rome Testnet to other chains, and so the decision
// was taken with the Rome Testnet team to only connect to 5 core testnets.
// This is also the reason for the selective IGP/gas oracle configuration.

export const core: ChainMap<CoreConfig> = objMap(
  ethereumChainOwners,
  (local, owner) => {
    // Special case for rometestnet2 due to non-standard gas metering.
    const connectedChains =
      local === 'rometestnet2'
        ? [
            'sepolia',
            'arbitrumsepolia',
            'basesepolia',
            'optimismsepolia',
            'bsctestnet',
          ]
        : supportedChainNames.filter((chain) => chain !== local);

    // Create a map of connected chains to their default multisig configs
    const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
      connectedChains.map((origin) => [origin, defaultMultisigConfigs[origin]]),
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
      domains: objMap(
        originMultisigs,
        (_, multisig): AggregationIsmConfig => ({
          type: IsmType.AGGREGATION,
          modules: [messageIdIsm(multisig), merkleRoot(multisig)],
          threshold: 1,
        }),
      ),
      ...owner,
    };

    // No static aggregation ISM support on zkSync
    const defaultZkSyncIsm = (): RoutingIsmConfig => ({
      type: IsmType.ROUTING,
      domains: objMap(
        originMultisigs,
        (_, multisig): MultisigIsmConfig => messageIdIsm(multisig),
      ),
      ...owner,
    });

    const pausableIsm: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      paused: false,
      ...owner,
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
      ...owner,
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
            protocolFee: BigNumber.from(0).toString(), // 0 wei of native token
            beneficiary: owner.owner as Address,
            ...owner,
          };

    return {
      defaultIsm,
      defaultHook,
      requiredHook,
      ...owner,
    };
  },
);
