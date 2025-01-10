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
import { Address, ProtocolType, objMap } from '@hyperlane-xyz/utils';

import { getChain } from '../../registry.js';

import { igp } from './igp.js';
import { owners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';

export const core: ChainMap<CoreConfig> = objMap(
  owners,
  (local, ownerConfig) => {
    const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
      supportedChainNames
        .filter((chain) => getChain(chain).protocol === ProtocolType.Ethereum)
        .filter((chain) => chain !== local)
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
      domains: objMap(
        originMultisigs,
        (_, multisig): AggregationIsmConfig => ({
          type: IsmType.AGGREGATION,
          modules: [messageIdIsm(multisig), merkleRoot(multisig)],
          threshold: 1,
        }),
      ),
      ...ownerConfig,
    };

    // No static aggregation ISM support on zkSync
    const defaultZkSyncIsm = (): RoutingIsmConfig => ({
      type: IsmType.ROUTING,
      domains: objMap(
        originMultisigs,
        (_, multisig): MultisigIsmConfig => messageIdIsm(multisig),
      ),
      ...ownerConfig,
    });

    const pausableIsm: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      paused: false,
      ...ownerConfig,
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
      ...ownerConfig,
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
      ...ownerConfig,
      domains: defaultHookDomains,
      fallback: merkleHook,
    };

    if (typeof ownerConfig.owner !== 'string') {
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
            protocolFee: BigNumber.from(1).toString(), // 1 wei of native token
            beneficiary: ownerConfig.owner as Address,
            ...ownerConfig,
          };

    return {
      defaultIsm,
      defaultHook,
      requiredHook,
      ...ownerConfig,
    };
  },
);
