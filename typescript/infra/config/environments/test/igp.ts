import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  IgpConfig,
  OwnableConfig,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  exclude,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

import { getChain } from '../../registry.js';

import { testChainNames } from './chains.js';
import { multisigIsm } from './multisigIsm.js';
import { owners } from './owners.js';

function getGasOracles(local: ChainName) {
  return Object.fromEntries(
    exclude(local, testChainNames).map((name) => [
      name,
      GasOracleContractType.StorageGasOracle,
    ]),
  );
}

const evmOwners = objFilter(
  owners,
  (chain, _): _ is OwnableConfig =>
    getChain(chain).protocol === ProtocolType.Ethereum,
);

export const igp: ChainMap<IgpConfig> = objMap(
  evmOwners,
  (chain, ownerConfig) => {
    const overhead = Object.fromEntries(
      exclude(chain, testChainNames).map((remote) => [
        remote,
        multisigIsmVerificationCost(
          multisigIsm[remote].threshold,
          multisigIsm[remote].validators.length,
        ),
      ]),
    );
    return {
      oracleKey: ownerConfig.owner as Address, // owner can be AccountConfig
      beneficiary: ownerConfig.owner as Address, // same as above
      gasOracleType: getGasOracles(chain),
      overhead,
      ...ownerConfig,
    };
  },
);
