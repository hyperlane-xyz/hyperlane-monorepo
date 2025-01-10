import {
  EthersAdapter,
  SafeAccountConfig,
  SafeFactory,
} from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

import { Contexts } from '../../config/contexts.js';
import safeSigners from '../../config/environments/mainnet3/safe/safeSigners.json' assert { type: 'json' };
import { Role } from '../../src/roles.js';
import { getSafeAndService } from '../../src/utils/safe.js';
import { getArgs, withChainRequired, withThreshold } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { chain, threshold } = await withThreshold(withChainRequired(getArgs()))
    .argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chain],
  );

  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({
    ethers,
    signerOrProvider: signer,
  });

  const safeFactory = await SafeFactory.create({
    ethAdapter,
  });

  const owners = safeSigners.signers;
  const safeAccountConfig: SafeAccountConfig = {
    owners,
    threshold,
  };

  const safe = await safeFactory.deploySafe({ safeAccountConfig });
  const safeAddress = await safe.getAddress();
  console.log(`Safe address: ${safeAddress}`);

  const { safeService } = await getSafeAndService(
    chain,
    multiProvider,
    safeAddress,
  );
  const serviceInfo = await safeService.getServiceInfo();
  console.log(serviceInfo);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
