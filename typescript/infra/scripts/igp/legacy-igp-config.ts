import { writeFile } from 'fs/promises';

import {
  ChainName,
  EvmHookModule,
  HookType,
  IgpConfig,
  IgpVersion,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import { assert, deepCopy } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getEnvAddresses } from '../../config/registry.js';
import { legacyIgpChains } from '../../src/config/chain.js';
import { Role } from '../../src/roles.js';
import {
  getArgs,
  withChains,
  withContext,
  withOutputFile,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function serializeTx(tx: Awaited<ReturnType<EvmHookModule['update']>>[number]) {
  return {
    annotation: tx.annotation,
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    ...(tx.value ? { value: tx.value.toString() } : {}),
  };
}

async function main() {
  const {
    environment,
    context = Contexts.Hyperlane,
    chains,
    execute,
    outFile,
  } = await withOutputFile(withChains(withContext(getArgs())))
    .describe('execute', 'Send transactions instead of only printing calldata')
    .boolean('execute')
    .default('execute', false).argv;

  const envConfig = getEnvironmentConfig(environment);
  const igpConfigs = envConfig.igp;
  const supportedChains = new Set<string>(envConfig.supportedChainNames);
  const requestedChains =
    chains && chains.length > 0
      ? chains.filter((chain): chain is ChainName => supportedChains.has(chain))
      : undefined;
  assert(
    !chains || requestedChains?.length === chains.length,
    `Unknown chain(s) requested: ${chains
      ?.filter((chain) => !supportedChains.has(chain))
      .join(', ')}`,
  );
  const configuredLegacyChains = legacyIgpChains.filter(
    (chain) =>
      envConfig.supportedChainNames.includes(chain) &&
      igpConfigs[chain]?.igpVersion === IgpVersion.Legacy,
  );
  const targetChains =
    requestedChains && requestedChains.length > 0
      ? requestedChains
      : configuredLegacyChains;

  assert(targetChains.length > 0, 'No legacy IGP chains selected');

  const nonLegacyChains = targetChains.filter(
    (chain) => igpConfigs[chain]?.igpVersion !== IgpVersion.Legacy,
  );
  assert(
    nonLegacyChains.length === 0,
    `Chains are not configured for legacy IGP: ${nonLegacyChains.join(', ')}`,
  );

  const multiProvider = await envConfig.getMultiProvider(
    context,
    execute ? Role.Deployer : undefined,
    true,
    targetChains,
  );
  const addresses = getEnvAddresses(environment);
  const plans = [];

  for (const chain of targetChains) {
    const chainAddresses = addresses[chain];
    const config = igpConfigs[chain];

    assert(chainAddresses, `Missing registry addresses for ${chain}`);
    assert(config, `Missing IGP config for ${chain}`);
    assert(
      config.type === HookType.INTERCHAIN_GAS_PAYMASTER,
      `Expected IGP hook config for ${chain}`,
    );
    assert(
      chainAddresses.interchainGasPaymaster,
      `Missing interchainGasPaymaster address for ${chain}`,
    );
    assert(chainAddresses.mailbox, `Missing mailbox address for ${chain}`);
    assert(
      chainAddresses.proxyAdmin,
      `Missing proxyAdmin address for ${chain}`,
    );

    const targetConfig: IgpConfig = {
      ...config,
      owner: config.ownerOverrides?.interchainGasPaymaster ?? config.owner,
    };
    const module = new EvmHookModule(multiProvider, {
      chain,
      config: targetConfig,
      addresses: {
        ...extractIsmAndHookFactoryAddresses(chainAddresses),
        mailbox: chainAddresses.mailbox,
        proxyAdmin: chainAddresses.proxyAdmin,
        deployedHook: chainAddresses.interchainGasPaymaster,
      },
    });
    const transactions = await module.update(deepCopy(targetConfig));
    const executed = [];

    if (execute) {
      for (const transaction of transactions) {
        const receipt = await multiProvider.sendTransaction(chain, transaction);
        executed.push(receipt.transactionHash);
      }
    }

    plans.push({
      chain,
      interchainGasPaymaster: chainAddresses.interchainGasPaymaster,
      transactionCount: transactions.length,
      transactions: transactions.map(serializeTx),
      ...(execute ? { executed } : {}),
    });
  }

  const output = JSON.stringify(
    {
      environment,
      context,
      mode: execute ? 'execute' : 'dry-run',
      plans,
    },
    null,
    2,
  );

  if (outFile) {
    await writeFile(outFile, output);
  }

  console.info(output);
}

main()
  .then()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
