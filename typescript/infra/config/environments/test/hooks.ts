// import {
//   ChainMap,
//   HookContractType,
//   InterceptorConfig,
//   NoMetadataIsmConfig,
//   OpStackHookConfig,
//   filterByChains,
// } from '@hyperlane-xyz/sdk';
// import { objMap } from '@hyperlane-xyz/utils';

// import { owners } from './owners';

// const chainNameFilter = new Set(['test1', 'test2']);
// const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

// export const hooks: ChainMap<InterceptorConfig> = objMap(
//   filteredOwnersResult,
//   (chain) => {
//     if (chain === 'test1') {
//       const hookConfig: OpStackHookConfig = {
//         hookContractType: HookContractType.HOOK,
//         nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
//         remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy, remoteISM should be deployed first
//         destination: 'test2',
//       };
//       return hookConfig;
//     } else {
//       const ismConfig: NoMetadataIsmConfig = {
//         hookContractType: HookContractType.ISM,
//         nativeBridge: '0x4200000000000000000000000000000000000007',
//       };
//       return ismConfig;
//     }
//   },
// );

// merkleRootHook
// const mrConfig: ChainMap<InterceptorConfig> = {
//   test1: {
//     type: HookContractType.HOOK,
//   },
//   test2: {
//     type: ModuleType.MERKLE_ROOT_MULTISIG,
//     validators: defaultMultisigIsmConfigs.optimism.validators,
//     threshold: defaultMultisigIsmConfigs.optimism.threshold,
//   },
// };
