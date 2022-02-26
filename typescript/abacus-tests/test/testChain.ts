import { ethers } from 'hardhat';

import { CoreDeploy } from '@abacus-network/abacus-deploy/dist/src/core/CoreDeploy';
import { CoreConfig } from '@abacus-network/abacus-deploy/dist/src/config/core';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '@abacus-network/abacus-deploy/dist/src/config/chain';
import { DeployEnvironment } from '@abacus-network/abacus-deploy/dist/src/deploy';

const { BigNumber } = ethers;

export async function getTestChain(
  domain: number,
  updater: string,
  watchers: string[],
  recoveryManager?: string,
  weth?: string,
): Promise<[ChainConfig, CoreConfig]> {
  const [, , , , , , , signer] = await ethers.getSigners();
  const chainJson: ChainConfigJson = {
    name: ChainName.LOCAL,
    rpc: '', // Replaced below
    deployerKey: '0x1234', // Replaced below
    domain,
    confirmations: 0,
    gasPrice: BigNumber.from(20000000000),
    gasLimit: BigNumber.from(6_000_000),
    weth,
  };
  const chain = new ChainConfig(chainJson);
  chain.signer = signer;
  chain.provider = ethers.provider;
  return [
    chain,
    {
      environment: DeployEnvironment.dev,
      recoveryTimelock: 1,
      optimisticSeconds: 3,
      processGas: 850_000,
      reserveGas: 15_000,
      addresses: {
        local: {
          updater,
          watchers,
          recoveryManager: recoveryManager || ethers.constants.AddressZero,
        },
      },
    },
  ];
}

export async function getTestDeploy(
  domain: number,
  updater: string,
  watchers: string[],
  recoveryManager?: string,
  weth?: string,
): Promise<CoreDeploy> {
  const [chain, config] = await getTestChain(
    domain,
    updater,
    watchers,
    recoveryManager,
    weth,
  );
  return new CoreDeploy(chain, config, true);
}
