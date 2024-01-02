import { BigNumber } from 'ethers';

import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  IgpConfig,
  MultisigConfig,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { AllStorageGasOracleConfigs } from '../src/config';

export function createIgpConfig(
  chainNames: ChainName[],
  storageGasOracleConfig: AllStorageGasOracleConfigs,
  multisigIsm: ChainMap<MultisigConfig>,
  owners: ChainMap<Address>,
  deployerAddress?: Address,
): ChainMap<IgpConfig> {
  return objMap(owners, (chain, owner) => {
    const gasOracleConfig = storageGasOracleConfig;
    const oracleConfig = Object.fromEntries(
      exclude(chain, chainNames).map((remote) => [
        remote,
        {
          type: GasOracleContractType.StorageGasOracle,
          overhead: BigNumber.from(
            multisigIsmVerificationCost(
              multisigIsm[remote].threshold,
              multisigIsm[remote].validators.length,
            ),
          ),
          tokenExchangeRate: BigNumber.from(
            gasOracleConfig[remote].tokenExchanegRate,
          ),
          gasPrice: BigNumber.from(gasOracleConfig[remote].gasPrice),
        },
      ]),
    );

    return {
      owner,
      oracleKey: deployerAddress ?? owner,
      beneficiary: deployerAddress ?? owner,
      oracleConfig,
    };
  });
}
