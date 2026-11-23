import { BigNumber, BigNumberish, constants, utils } from 'ethers';

import type { LayerZeroV2HookIsm } from '@hyperlane-xyz/core';
import { Address, assert } from '@hyperlane-xyz/utils';

import {
  LayerZeroV2ConfigMode,
  LayerZeroV2EffectiveExecutorConfig,
  LayerZeroV2EffectiveExecutorConfigSchema,
  LayerZeroV2EffectiveUlnConfig,
  LayerZeroV2EffectiveUlnConfigSchema,
  LayerZeroV2ExecutorConfig,
  LayerZeroV2ExecutorConfigSchema,
  LayerZeroV2ReceiveConfig,
  LayerZeroV2SendConfig,
  LayerZeroV2UlnConfig,
  LayerZeroV2UlnConfigSchema,
} from './types.js';

export const LayerZeroV2ConfigType = {
  Executor: 1,
  Uln: 2,
} as const;

const DEFAULT_VALUE = 0;
const NIL_DVN_COUNT = 0xff;
const NIL_CONFIRMATIONS = BigNumber.from(2).pow(64).sub(1);
const EXECUTOR_CONFIG_TYPE =
  'tuple(uint32 maxMessageSize,address executor)' as const;
const ULN_CONFIG_TYPE =
  'tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)' as const;

function decodeCount(
  count: number,
  dvns: Address[],
  label: string,
): Address[] | undefined {
  if (count === DEFAULT_VALUE) {
    if (dvns.length !== 0) {
      throw new Error(`${label} uses DEFAULT but contains DVNs`);
    }
    return undefined;
  }
  if (count === NIL_DVN_COUNT) {
    if (dvns.length !== 0) {
      throw new Error(`${label} uses NONE but contains DVNs`);
    }
    return [];
  }
  if (count !== dvns.length) {
    throw new Error(
      `${label} count ${count} does not match ${dvns.length} DVNs`,
    );
  }
  return dvns;
}

/** On-chain `ExecutorConfig`; all-zero selects the library default. */
type ExecutorConfigStruct =
  LayerZeroV2HookIsm.RemoteRouterConfigStruct['executorConfig'];

/** On-chain `UlnConfig`; all-zero selects the library default. */
type UlnConfigStruct =
  LayerZeroV2HookIsm.RemoteRouterConfigStruct['sendUlnConfig'];

function executorConfigStruct(
  input: LayerZeroV2ExecutorConfig,
): ExecutorConfigStruct {
  const config = LayerZeroV2ExecutorConfigSchema.parse(input);
  return {
    maxMessageSize:
      config.type === LayerZeroV2ConfigMode.Override
        ? (config.maxMessageSize ?? DEFAULT_VALUE)
        : DEFAULT_VALUE,
    executor:
      config.type === LayerZeroV2ConfigMode.Override
        ? (config.executor ?? constants.AddressZero)
        : constants.AddressZero,
  };
}

export function encodeLayerZeroV2ExecutorConfig(
  input: LayerZeroV2ExecutorConfig,
): string {
  return utils.defaultAbiCoder.encode(
    [EXECUTOR_CONFIG_TYPE],
    [executorConfigStruct(input)],
  );
}

export function decodeLayerZeroV2AppExecutorConfig(
  maxMessageSize: number,
  executor: Address,
): LayerZeroV2ExecutorConfig {
  if (maxMessageSize === DEFAULT_VALUE && executor === constants.AddressZero) {
    return { type: LayerZeroV2ConfigMode.Default };
  }
  return LayerZeroV2ExecutorConfigSchema.parse({
    type: LayerZeroV2ConfigMode.Override,
    ...(maxMessageSize !== DEFAULT_VALUE ? { maxMessageSize } : {}),
    ...(executor !== constants.AddressZero ? { executor } : {}),
  });
}

export function decodeLayerZeroV2EffectiveExecutorConfig(
  encoded: string,
): LayerZeroV2EffectiveExecutorConfig {
  const [config] = utils.defaultAbiCoder.decode(
    [EXECUTOR_CONFIG_TYPE],
    encoded,
  );
  return LayerZeroV2EffectiveExecutorConfigSchema.parse({
    maxMessageSize: Number(config.maxMessageSize),
    executor: config.executor,
  });
}

function ulnConfigStruct(input: LayerZeroV2UlnConfig): UlnConfigStruct {
  const config = LayerZeroV2UlnConfigSchema.parse(input);
  const isOverride = config.type === LayerZeroV2ConfigMode.Override;
  const requiredDVNs = isOverride ? config.requiredDVNs : undefined;
  const optionalDVNs = isOverride ? config.optionalDVNs : undefined;
  const confirmations = isOverride ? config.confirmations : undefined;
  const optionalDVNThreshold =
    optionalDVNs === undefined || optionalDVNs.length === 0
      ? 0
      : isOverride
        ? config.optionalDVNThreshold
        : undefined;
  assert(
    optionalDVNThreshold !== undefined,
    'optionalDVNThreshold is required with optionalDVNs',
  );
  return {
    confirmations:
      confirmations === undefined
        ? DEFAULT_VALUE
        : confirmations === 0n
          ? NIL_CONFIRMATIONS
          : confirmations,
    requiredDVNCount:
      requiredDVNs === undefined
        ? DEFAULT_VALUE
        : requiredDVNs.length === 0
          ? NIL_DVN_COUNT
          : requiredDVNs.length,
    optionalDVNCount:
      optionalDVNs === undefined
        ? DEFAULT_VALUE
        : optionalDVNs.length === 0
          ? NIL_DVN_COUNT
          : optionalDVNs.length,
    optionalDVNThreshold,
    requiredDVNs: requiredDVNs ?? [],
    optionalDVNs: optionalDVNs ?? [],
  };
}

export function encodeLayerZeroV2UlnConfig(
  input: LayerZeroV2UlnConfig,
): string {
  return utils.defaultAbiCoder.encode(
    [ULN_CONFIG_TYPE],
    [ulnConfigStruct(input)],
  );
}

export function decodeLayerZeroV2AppUlnConfig(
  confirmationsInput: BigNumberish,
  requiredDVNCount: number,
  optionalDVNCount: number,
  optionalDVNThreshold: number,
  requiredDVNsInput: Address[],
  optionalDVNsInput: Address[],
): LayerZeroV2UlnConfig {
  const confirmations = BigNumber.from(confirmationsInput);
  const requiredDVNs = decodeCount(
    requiredDVNCount,
    requiredDVNsInput,
    'requiredDVNs',
  );
  const optionalDVNs = decodeCount(
    optionalDVNCount,
    optionalDVNsInput,
    'optionalDVNs',
  );
  if (
    (optionalDVNCount === DEFAULT_VALUE ||
      optionalDVNCount === NIL_DVN_COUNT) &&
    optionalDVNThreshold !== 0
  ) {
    throw new Error(
      'optionalDVNThreshold must be 0 when optional DVNs use DEFAULT or NONE',
    );
  }
  if (
    confirmations.eq(DEFAULT_VALUE) &&
    requiredDVNs === undefined &&
    optionalDVNs === undefined
  ) {
    return { type: LayerZeroV2ConfigMode.Default };
  }
  return LayerZeroV2UlnConfigSchema.parse({
    type: LayerZeroV2ConfigMode.Override,
    ...(!confirmations.eq(DEFAULT_VALUE)
      ? {
          confirmations: confirmations.eq(NIL_CONFIRMATIONS)
            ? 0n
            : confirmations.toBigInt(),
        }
      : {}),
    ...(requiredDVNs !== undefined ? { requiredDVNs } : {}),
    ...(optionalDVNs !== undefined
      ? { optionalDVNs, optionalDVNThreshold }
      : {}),
  });
}

export function decodeLayerZeroV2EffectiveUlnConfig(
  encoded: string,
): LayerZeroV2EffectiveUlnConfig {
  const [config] = utils.defaultAbiCoder.decode([ULN_CONFIG_TYPE], encoded);
  const requiredDVNCount = Number(config.requiredDVNCount);
  const optionalDVNCount = Number(config.optionalDVNCount);
  const optionalDVNThreshold = Number(config.optionalDVNThreshold);
  if (requiredDVNCount !== config.requiredDVNs.length) {
    throw new Error(
      `Effective requiredDVNs count ${requiredDVNCount} does not match ${config.requiredDVNs.length} DVNs`,
    );
  }
  if (optionalDVNCount !== config.optionalDVNs.length) {
    throw new Error(
      `Effective optionalDVNs count ${optionalDVNCount} does not match ${config.optionalDVNs.length} DVNs`,
    );
  }
  if (
    (optionalDVNCount === 0 && optionalDVNThreshold !== 0) ||
    optionalDVNThreshold > optionalDVNCount
  ) {
    throw new Error('Effective optional DVN threshold is invalid');
  }
  if (requiredDVNCount === 0 && optionalDVNThreshold === 0) {
    throw new Error('Effective ULN config must retain at least one DVN');
  }
  return LayerZeroV2EffectiveUlnConfigSchema.parse({
    confirmations: BigNumber.from(config.confirmations).toBigInt(),
    requiredDVNs: config.requiredDVNs,
    optionalDVNs: config.optionalDVNs,
    optionalDVNThreshold,
  });
}

/**
 * Complete outbound policy for an enrollment. Inherited settings are encoded
 * as all-zero structs so every enrollment rewrites the full policy.
 */
export function layerZeroV2SendConfigParams(config: LayerZeroV2SendConfig): {
  executorConfig: ExecutorConfigStruct;
  sendUlnConfig: UlnConfigStruct;
} {
  return {
    executorConfig: executorConfigStruct(config.executor),
    sendUlnConfig: ulnConfigStruct(config.uln),
  };
}

/** Complete inbound policy for an enrollment; see `layerZeroV2SendConfigParams`. */
export function layerZeroV2ReceiveConfigParams(
  config: LayerZeroV2ReceiveConfig,
): { receiveUlnConfig: UlnConfigStruct } {
  return { receiveUlnConfig: ulnConfigStruct(config.uln) };
}
