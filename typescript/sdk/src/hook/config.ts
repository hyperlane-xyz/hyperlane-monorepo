import {
  HookConfig,
  MessageHookConfig,
  NativeType,
  NoMetadataIsmConfig,
} from './types';

export const isISMConfig = (
  config: HookConfig,
): config is NoMetadataIsmConfig => config.nativeType === NativeType.ISM;

export const isHookConfig = (config: HookConfig): config is MessageHookConfig =>
  config.nativeType === NativeType.HOOK;
