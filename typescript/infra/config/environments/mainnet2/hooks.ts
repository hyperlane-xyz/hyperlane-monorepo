// import {
//   ChainMap,
//   InterceptorType,
//   InterceptorConfig,
//   NoMetadataIsmConfig,
//   OpStackHookConfig,
//   filterByChains,
// } from '@hyperlane-xyz/sdk';
// import { objMap } from '@hyperlane-xyz/utils';

// import { owners } from './owners';

// const chainNameFilter = new Set(['ethereum', 'optimism']);
// const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

// export const hooks: ChainMap<InterceptorConfig> = objMap(
//   filteredOwnersResult,
//   (chain) => {
//     if (chain === 'ethereum') {
//       const hookConfig: OpStackHookConfig = {
//         InterceptorType: InterceptorType.HOOK,
//         mailbox: '0x23',
//         nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
//         remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy, remoteISM should be deployed first
//         destination: 'optimism',
//       };
//       return hookConfig;
//     } else {
//       const ismConfig: NoMetadataIsmConfig = {
//         InterceptorType: InterceptorType.ISM,
//         nativeBridge: '0x4200000000000000000000000000000000000007',
//       };
//       return ismConfig;
//     }
//   },
// );
