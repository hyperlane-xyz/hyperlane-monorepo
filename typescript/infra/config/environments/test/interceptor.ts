import { ChainMap, InterceptorConfig } from '@hyperlane-xyz/sdk';
import { HookType } from '@hyperlane-xyz/sdk/src/hook/types';
import { objMap } from '@hyperlane-xyz/utils';

import {
  chainToValidator,
  merkleRootMultisig,
  messageIdMultisig,
} from './multisigIsm';
import { owners } from './owners';

export const merkleRoot: ChainMap<InterceptorConfig> = objMap(
  owners,
  (chain, _) => {
    const config: InterceptorConfig = {
      hook: {
        type: HookType.MERKLE_ROOT_HOOK,
      },
      ism:
        Math.random() < 0.5
          ? merkleRootMultisig(chainToValidator[chain])
          : messageIdMultisig(chainToValidator[chain]),
    };
    return config;
  },
);
