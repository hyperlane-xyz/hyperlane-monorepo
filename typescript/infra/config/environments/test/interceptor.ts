import { BigNumber } from 'ethers';

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

// test1 -> test2, test2 -> test3
export const opStack: ChainMap<InterceptorConfig> = {
  test1: {
    hook: {
      type: InterceptorType.HOOK,
      nativeBridge: '0xa85233c63b9ee964add6f2cffe00fd84eb32338f',
      destinationDomain: BigNumber.from(10),
      destination: 'test2',
    },
  },
  test2: {
    hook: {
      type: InterceptorType.HOOK,
      nativeBridge: '0xa85233c63b9ee964add6f2cffe00fd84eb32338f',
      destinationDomain: BigNumber.from(11),
      destination: 'test3',
    },
    ism: {
      type: InterceptorType.ISM,
      origin: 'test1',
      nativeBridge: '0x322813fd9a801c5507c9de605d63cea4f2ce6c44',
    },
  },
  test3: {
    ism: {
      type: InterceptorType.ISM,
      origin: 'test2',
      nativeBridge: '0x322813fd9a801c5507c9de605d63cea4f2ce6c44',
    },
  },
};
