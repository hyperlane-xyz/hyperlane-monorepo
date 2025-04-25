import chalk from 'chalk';
import { ethers } from 'ethers';
import prompts from 'prompts';

import { Ownable__factory } from '@hyperlane-xyz/core';
import { Token, TokenStandard } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getWarpConfigsAndArtifacts } from '../../src/xerc20/utils.js';
import {
  getArgs,
  withChains,
  withDryRun,
  withKnownWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function transferTokenOwnership(
  token: Token,
  chains: string[] | undefined,
  dryRun: boolean,
  multiProvider: any,
  warpDeployConfig: any,
) {
  if (chains && !chains.includes(token.chainName)) {
    rootLogger.info(
      chalk.gray(
        `Skipping token ${token.symbol} on chain ${token.chainName}...`,
      ),
    );
    return;
  }

  assert(
    token.collateralAddressOrDenom,
    `Token ${token.symbol} has no collateral address`,
  );

  let xerc20 = token.collateralAddressOrDenom;
  if (
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    rootLogger.info(
      chalk.gray(
        `Skipping token ${token.symbol} on chain ${token.chainName}...`,
      ),
    );

    const lockbox = new ethers.Contract(
      token.collateralAddressOrDenom,
      ['function XERC20() view returns (address)'],
      multiProvider.getProvider(token.chainName),
    );
    xerc20 = await lockbox.XERC20();
  }

  const ownableXERC20 = Ownable__factory.connect(
    xerc20,
    multiProvider.getSigner(token.chainName),
  );

  const configuredOwner = warpDeployConfig[token.chainName].owner;
  assert(configuredOwner, `Token ${token.symbol} has no owner`);

  const currentOwner = await ownableXERC20.owner();

  if (eqAddress(currentOwner, configuredOwner)) {
    rootLogger.info(
      chalk.gray(
        `Token ${token.symbol} on chain ${token.chainName} already has correct owner ${currentOwner}, skipping...`,
      ),
    );
    return;
  }

  const transferTx = await ownableXERC20.populateTransaction.transferOwnership(
    configuredOwner,
  );

  rootLogger.info(
    chalk.gray(
      `Transferring ownership of token ${token.symbol} on chain ${token.chainName} from ${currentOwner} to ${configuredOwner}`,
    ),
  );

  if (dryRun) {
    rootLogger.info(
      chalk.gray(
        `Dry run for token ${token.symbol} on chain ${token.chainName} at address ${xerc20}, no transactions sent, exiting...`,
      ),
    );
    return;
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Confirm ownership transfer for token ${token.symbol} on chain ${token.chainName}?`,
    initial: false,
  });

  if (!confirm) {
    rootLogger.info(
      chalk.gray(
        `Skipping ownership transfer for token ${token.symbol} on chain ${token.chainName}`,
      ),
    );
    return;
  }

  rootLogger.info(
    chalk.gray(
      `Sending ownership transfer transaction for token ${token.symbol} on chain ${token.chainName}`,
    ),
  );

  await multiProvider.sendTransaction(token.chainName, transferTx);
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId, chains, dryRun } = await withChains(
    withKnownWarpRouteIdRequired(withDryRun(getArgs())),
  ).argv;

  const { warpDeployConfig, warpCoreConfig } =
    getWarpConfigsAndArtifacts(warpRouteId);

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  for (const token of warpCoreConfig.tokens) {
    try {
      await transferTokenOwnership(
        token as Token,
        chains,
        dryRun,
        multiProvider,
        warpDeployConfig,
      );
    } catch (error) {
      rootLogger.error(
        chalk.red(
          `Failed to transfer ownership for token ${token.symbol} on chain ${token.chainName}: ${error}`,
        ),
      );
    }
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
