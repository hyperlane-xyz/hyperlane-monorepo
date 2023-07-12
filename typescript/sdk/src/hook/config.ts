import {
  HookConfig,
  HookContractType,
  MessageHookConfig,
  NoMetadataIsmConfig,
} from './types';

export const isISMConfig = (
  config: HookConfig,
): config is NoMetadataIsmConfig =>
  config.hookContractType === HookContractType.ISM;

export const isHookConfig = (config: HookConfig): config is MessageHookConfig =>
  config.hookContractType === HookContractType.HOOK;
