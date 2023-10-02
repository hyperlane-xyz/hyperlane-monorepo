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

// const chainNameFilter = new Set(['goerli', 'optimismgoerli']);
// const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

// export const hooks: ChainMap<InterceptorConfig> = objMap(
//   filteredOwnersResult,
//   (chain) => {
//     if (chain === 'goerli') {
//       const hookConfig: OpStackHookConfig = {
//         hookContractType: HookContractType.HOOK,
//         nativeBridge: '0x5086d1eEF304eb5284A0f6720f79403b4e9bE294',
//         destination: 'optimismgoerli',
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
