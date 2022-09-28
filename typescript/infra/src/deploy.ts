import {
  ChainMap,
  HyperlaneContracts,
  HyperlaneDeployer,
  HyperlaneFactories,
  buildContracts,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { readJSON, writeJSON } from './utils/utils';

export async function deployWithArtifacts<T extends HyperlaneFactories>(
  dir: string,
  factories: T,
  deployer: HyperlaneDeployer<any, any, any, T>,
) {
  let contracts: ChainMap<any, HyperlaneContracts> = {};
  try {
    const addresses = readJSON(dir, 'addresses.json');
    contracts = buildContracts(addresses, factories) as any;
  } catch (e) {
    console.error(e);
  }

  try {
    contracts = await deployer.deploy(contracts);
  } catch (e) {
    console.error(e);
    contracts = deployer.deployedContracts as any;
  }
  writeJSON(dir, 'verification.json', deployer.verificationInputs);
  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
}
