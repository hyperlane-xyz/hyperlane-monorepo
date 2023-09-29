import {
  ChainMap,
  InterceptorType,
  MultisigIsmConfig,
  RoutingInterceptorConfig,
} from '@hyperlane-xyz/sdk';
import { ModuleType } from '@hyperlane-xyz/sdk/src';
import {
  MerkleRootHookConfig,
  MerkleRootInterceptorConfig,
} from '@hyperlane-xyz/sdk/src/hook/types';
import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { chainToValidator, merkleRootMultisig } from './multisigIsm';
import { owners } from './owners';

export const merkleRoot: ChainMap<MerkleRootInterceptorConfig> = objMap(
  owners,
  (chain, _) => {
    const config: MerkleRootInterceptorConfig = {
      hook: {
        type: InterceptorType.HOOK,
      },
      ism: merkleRootMultisig(chainToValidator[chain]),
    };
    return config;
  },
);

export const routing: ChainMap<RoutingInterceptorConfig> = objMap(
  owners,
  (chain, owner) => {
    const config: RoutingInterceptorConfig = {
      hook: {
        type: InterceptorType.HOOK,
        domains: objFilter(
          objMap(owners, (_, __) => {
            const config: MerkleRootHookConfig = {
              type: InterceptorType.HOOK,
            };
            return config;
          }),
          (dest, config): config is MerkleRootHookConfig => dest !== chain,
        ),
      },
      ism: {
        type: ModuleType.ROUTING,
        owner: owner,
        domains: objFilter(
          objMap(owners, (origin, __) => {
            const ism = merkleRootMultisig(chainToValidator[origin]);
            return ism;
          }),
          (dest, config): config is MultisigIsmConfig => dest !== chain,
        ),
      },
    };
    return config;
  },
);
