import {
  ChainMap,
  InterceptorConfig,
  InterceptorType,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { chainToValidator, merkleRootMultisig } from './multisigIsm';
import { owners } from './owners';

export const merkleRoot: ChainMap<InterceptorConfig> = objMap(
  owners,
  (chain, _) => {
    const config: InterceptorConfig = {
      hook: {
        type: InterceptorType.HOOK,
      },
      ism: merkleRootMultisig(chainToValidator[chain]),
    };
    return config;
  },
);

// const mrConfig: ChainMap<InterceptorConfig> = {
//   test1: {
//     type: InterceptorType.HOOK,
//     destinationDomain: BigNumber.from(10),
//     destination: 'test2',
//     nativeBridge: '0xa85233c63b9ee964add6f2cffe00fd84eb32338f',
//   },
//   test2: {
//     type: InterceptorType.ISM,
//     origin: 'test1',
//     nativeBridge: '0x322813fd9a801c5507c9de605d63cea4f2ce6c44',
//   },
// };
