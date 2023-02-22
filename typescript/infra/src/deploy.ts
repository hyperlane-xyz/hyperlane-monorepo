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
  deployer: HyperlaneDeployer<any, any, T>,
) {
  let contracts: ChainMap<HyperlaneContracts> = {};
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

  try {
    const existingVerificationInputs = readJSON(dir, 'verification.json');
    writeJSON(
      dir,
      'verification.json',
      deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
    );
  } catch {
    writeJSON(dir, 'verification.json', deployer.verificationInputs);
  }

  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
}
