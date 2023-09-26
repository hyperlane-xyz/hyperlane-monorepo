import {
  HookContractType,
  InterceptorConfig,
  PostDispatchHookConfig,
} from './types';

// TODO: what is a hook config was an address?
export const isHookConfig = (
  config: InterceptorConfig,
): config is PostDispatchHookConfig =>
  typeof config !== 'string' && config.type === HookContractType.HOOK;
