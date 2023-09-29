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
