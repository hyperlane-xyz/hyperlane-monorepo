import { Ownable__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import {
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils/dist/src/utils';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { readJSON } from '../src/utils/utils';

import {
  getCoreEnvironmentConfig,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

const PROXY_ADMIN_STORAGE_KEY =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  ) as HyperlaneCore<any>;

  const verificationDir = getCoreVerificationDirectory(environment);
  const verificationFile = 'verification.json';
  const verification = readJSON(verificationDir, verificationFile);

  console.log('chains', core.chains());

  for (const chain of core.chains()) {
    const igp = core.getContracts(chain).interchainGasPaymaster.contract;
    const igpOwner = await igp.owner();
    const provider = multiProvider.getChainProvider(chain);
    const igpAdmin = bytes32ToAddress(
      await provider.getStorageAt(igp.address, PROXY_ADMIN_STORAGE_KEY),
    );
    const deployerOwnedProxyAdmin = verification[chain]?.find(
      (v: any) => v.name === 'DeployerOwnedProxyAdmin',
    )?.address;
    const intendedOwner = config.core[chain].owner;
    const intendedProxyAdmin = core.getAddresses(chain).proxyAdmin as string;

    console.log('Chain', chain);
    console.log('Intended owner address', intendedOwner);
    console.log('Canonical proxy admin', intendedProxyAdmin);
    console.log('deployerOwnedProxyAdmin', deployerOwnedProxyAdmin);

    console.log('\n');

    console.log('IGP', igp.address);
    console.log('IGP owner', igpOwner);
    console.log('IGP proxy admin', igpAdmin);
    console.log(
      'IGP proxy admin owner',
      await Ownable__factory.connect(igpAdmin, provider).owner(),
    );

    console.log(
      'IGP owner is',
      eqAddress(igpOwner, intendedOwner) ? 'CORRECT' : 'NOT CORRECT',
    );
    console.log(
      'IGP owner is deployerOwnedProxyAdmin?',
      deployerOwnedProxyAdmin
        ? eqAddress(igpOwner, deployerOwnedProxyAdmin)
        : false,
    );
    console.log(
      'IGP owner is canonical proxy admin?',
      eqAddress(igpOwner, intendedProxyAdmin),
    );
    console.log(
      'IGP proxy admin is',
      eqAddress(igpAdmin, intendedProxyAdmin) ? 'CORRECT' : 'NOT CORRECT',
    );
    console.log('------\n\n\n');
  }
}

main();
