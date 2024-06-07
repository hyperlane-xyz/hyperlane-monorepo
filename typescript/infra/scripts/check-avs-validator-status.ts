import { ethers } from 'ethers';

import {
  ECDSAStakeRegistry__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getChainAddresses, getEnvChains } from '../config/registry.js';
import { DeployEnvironment } from '../src/config/environment.js';

import { getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const stakeRegistryAddress = '0xFfa913705484C9BAea32Ffe9945BeA099A1DFF72';

  async function checkValidators(chainEnv: DeployEnvironment) {
    const chains = getEnvChains(chainEnv);
    const addresses = getChainAddresses();

    for (const chain of chains) {
      const chainAddresses = addresses[chain];
      if (chainAddresses) {
        const va = ValidatorAnnounce__factory.connect(
          chainAddresses.validatorAnnounce,
          multiProvider.getSigner(chain),
        );
        const announcedValidators = await va.getAnnouncedValidators();
        for (const validatorKey of validatingKeys) {
          if (announcedValidators.includes(validatorKey)) {
            avsKeys
              .find((key) => key.signingKey === validatorKey)
              ?.chains.push(chain);
          }
        }
      }
    }
  }

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    multiProvider.getSigner('holesky'),
  );

  const filter = ecdsaStakeRegistry.filters.SigningKeyUpdate(null, null);
  const provider = new ethers.providers.StaticJsonRpcProvider(
    multiProvider.getRpcUrl('holesky'),
  );
  const latestBlock = await provider.getBlockNumber();
  const blockLimit = 50000; // 50k blocks per query

  let fromBlock = 1625972; // when ecdsaStakeRegistry was deployed

  let avsKeys: {
    operatorKey: Address;
    signingKey: Address;
    chains: ChainName[];
  }[] = [];

  const avsKeysMap = new Map();

  while (fromBlock < latestBlock) {
    const toBlock = Math.min(fromBlock + blockLimit, latestBlock);

    const logs = await ecdsaStakeRegistry.queryFilter(
      filter,
      fromBlock,
      toBlock,
    );

    logs.forEach((log) => {
      const event = ecdsaStakeRegistry.interface.parseLog(log);
      const operatorKey = event.args.operator;
      const signingKey = event.args.newSigningKey;

      if (avsKeysMap.has(operatorKey)) {
        const existingEntry = avsKeysMap.get(operatorKey);
        existingEntry.signingKey = signingKey;
      } else {
        avsKeysMap.set(operatorKey, {
          operatorKey,
          signingKey,
          chains: [],
        });
      }
    });

    fromBlock = toBlock + 1;
  }

  avsKeys = Array.from(avsKeysMap.values());

  const validatingKeys = avsKeys.map((key) => key.signingKey);

  await checkValidators('testnet4');
  await checkValidators('mainnet3');

  console.log(JSON.stringify(avsKeys, null, 2));
}

main().catch(console.error);
