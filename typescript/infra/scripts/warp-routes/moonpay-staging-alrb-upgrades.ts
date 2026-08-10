import yargs from 'yargs';

import {
  Ownable__factory,
  PackageVersioned__factory,
} from '@hyperlane-xyz/core';
import {
  MultiProvider,
  proxyAdmin,
  proxyImplementation,
} from '@hyperlane-xyz/sdk';
import { assert, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { environment as mainnet3 } from '../../config/environments/mainnet3/index.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import {
  MOONPAY_STAGING_USDT_V12_UPGRADES,
  MoonpayStagingAlrbChain,
  getMoonpayStagingUsdtV12UpgradeTransactions,
} from '../../config/environments/mainnet3/warp/moonpayStagingAlrb.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { Role } from '../../src/roles.js';

const ALL_CHAINS = Object.keys(
  MOONPAY_STAGING_USDT_V12_UPGRADES,
) as MoonpayStagingAlrbChain[];

async function main() {
  const { chains = ALL_CHAINS, send } = await yargs(process.argv.slice(2))
    .option('chains', {
      array: true,
      choices: ALL_CHAINS,
      description: 'Staging source-router chains to upgrade',
      type: 'string',
    })
    .option('send', {
      default: false,
      description: 'Sign and broadcast after all preflight checks pass',
      type: 'boolean',
    })
    .strict()
    .parse();

  const selectedChains = chains as MoonpayStagingAlrbChain[];
  const registry = await mainnet3.getRegistry(send, selectedChains);
  const multiProvider = send
    ? await mainnet3.getMultiProvider(
        Contexts.Hyperlane,
        Role.Deployer,
        true,
        selectedChains,
      )
    : new MultiProvider(await registry.getMetadata());
  const transactions = getMoonpayStagingUsdtV12UpgradeTransactions();
  const sourceRoute = await registry.getWarpRoute(
    WarpRouteIds.USDTCitreaMoonpaySTAGING,
  );
  assert(sourceRoute, 'USDT/moonpay-staging route not found in registry');
  const pendingChains: MoonpayStagingAlrbChain[] = [];

  for (const chain of selectedChains) {
    const provider = multiProvider.getProvider(chain);
    const expected = MOONPAY_STAGING_USDT_V12_UPGRADES[chain];
    const registeredProxy: string | undefined = sourceRoute.tokens.find(
      ({ chainName }) => chainName === chain,
    )?.addressOrDenom;
    assert(
      registeredProxy,
      `Missing registered staging USDT router on ${chain}`,
    );
    assert(
      eqAddress(registeredProxy, expected.proxy),
      `${chain} registered router is ${registeredProxy}, expected ${expected.proxy}`,
    );
    const [actualAdmin, actualImplementation, targetCode, targetVersion] =
      await Promise.all([
        proxyAdmin(provider, expected.proxy),
        proxyImplementation(provider, expected.proxy),
        provider.getCode(expected.implementation),
        PackageVersioned__factory.connect(
          expected.implementation,
          provider,
        ).PACKAGE_VERSION(),
      ]);

    assert(
      eqAddress(actualAdmin, expected.proxyAdmin),
      `${chain} proxy admin is ${actualAdmin}, expected ${expected.proxyAdmin}`,
    );
    assert(
      targetCode !== '0x',
      `${chain} target implementation has no bytecode`,
    );
    assert(
      targetVersion === '12.0.0',
      `${chain} target implementation reports ${targetVersion}, expected 12.0.0`,
    );

    if (eqAddress(actualImplementation, expected.implementation)) {
      rootLogger.info(`${chain} is already on the audited v12 implementation`);
      continue;
    }

    const adminOwner = await Ownable__factory.connect(
      expected.proxyAdmin,
      provider,
    ).owner();
    assert(
      eqAddress(adminOwner, DEPLOYER),
      `${chain} ProxyAdmin owner is ${adminOwner}, expected ${DEPLOYER}`,
    );
    pendingChains.push(chain);
    if (!send) {
      rootLogger.info({ chain, transaction: transactions[chain] });
    }
  }

  if (send) {
    for (const chain of pendingChains) {
      const receipt = await multiProvider.sendTransaction(
        chain,
        transactions[chain],
      );
      rootLogger.info(
        `${chain} upgrade confirmed in ${receipt.transactionHash}`,
      );
    }
  }

  if (!send) {
    rootLogger.info('Dry run only. Re-run with --send to sign and broadcast.');
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
