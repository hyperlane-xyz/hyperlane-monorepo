import { BigNumber } from 'ethers';

import { createSafeDeploymentTransaction } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSigners } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import { getArgs, withChainRequired, withThreshold } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const DEFAULT_SAFE_HOME_URL = 'https://app.safe.global';

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

async function main() {
  const { chain, safeHomeUrl, threshold, governanceType } =
    await withGovernanceType(
      withThreshold(withChainRequired(getArgs()))
        .string('safeHomeUrl')
        .describe('safeHomeUrl', 'Safe web UI base URL')
        .default('safeHomeUrl', DEFAULT_SAFE_HOME_URL),
    ).argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chain],
  );

  const { signers, threshold: defaultThreshold } =
    getGovernanceSigners(governanceType);
  const safeDeploymentConfig = {
    owners: signers,
    threshold: threshold ?? defaultThreshold,
  };

  const { safeAddress, transaction } = await createSafeDeploymentTransaction(
    chain,
    multiProvider,
    safeDeploymentConfig,
  );
  await multiProvider.sendTransaction(chain, {
    to: transaction.to,
    data: transaction.data,
    value: BigNumber.from(transaction.value),
  });

  rootLogger.info(`Safe address: ${safeAddress}`);
  rootLogger.info(`Safe url: ${safeHomeUrl}/home?safe=${chain}:${safeAddress}`);
  rootLogger.info('Please confirm the safe is created by following the link');
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(stringifyValueForError(e));
    process.exit(1);
  });
