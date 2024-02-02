import { BigNumber } from 'ethers';

import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { StorageGasOraclesConfig } from '../gas/oracle/types';
import { IgpConfig } from '../gas/types';
import { MultisigConfig } from '../ism/types';
import { ChainMap, ChainName } from '../types';
import { multisigIsmVerificationCost } from '../utils/ism';

export function createIgpConfig(
  chainNames: ChainName[],
  storageGasOracleConfig: ChainMap<StorageGasOraclesConfig>,
  multisigIsm: ChainMap<MultisigConfig>,
  owners: ChainMap<Address>,
  oracleKeys: ChainMap<Address> = owners,
  beneficiaries: ChainMap<Address> = owners,
  deployerAddress?: Address,
): ChainMap<IgpConfig> {
  return objMap(owners, (chain, owner) => {
    const overhead = Object.fromEntries(
      exclude(chain, chainNames).map((remote) => [
        remote,
        BigNumber.from(
          multisigIsmVerificationCost(
            multisigIsm[remote].threshold,
            multisigIsm[remote].validators.length,
          ),
        ),
      ]),
    );
    return {
      owner,
      oracleKey: deployerAddress ?? oracleKeys[chain],
      beneficiary: deployerAddress ?? beneficiaries[chain],
      oracleConfig: storageGasOracleConfig[chain],
      overhead,
    };
  });
}
