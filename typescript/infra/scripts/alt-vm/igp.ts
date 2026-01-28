import { BigNumber } from 'bignumber.js';
import { writeFileSync } from 'fs';
import prompts from 'prompts';

import {
  AltVMJsonRpcSubmitter,
  createHookReader,
  createHookWriter,
  loadProtocolProviders,
} from '@hyperlane-xyz/deploy-sdk';
import { getProtocolProvider, hasProtocol } from '@hyperlane-xyz/provider-sdk';
import { HookConfig as ProviderHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  IgpConfig,
  MultiProvider,
  getProtocolExchangeRateScale,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChainAddresses } from '../../config/registry.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { Role } from '../../src/roles.js';
import { getArgs, withChains, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'altvm-igp' });

function exampleCost(
  remote: string,
  provider: MultiProvider,
  config: IgpConfig,
) {
  const overhead = config.overhead[remote];
  const exampleRemoteGas = (overhead ?? 200_000) + 50_000;
  const oracleData = config.oracleConfig[remote] || {
    gasPrice: 0,
    tokenExchangeRate: 1,
  };
  const protocol = provider.getProtocol(remote);
  const exampleRemoteGasCost = new BigNumber(oracleData.tokenExchangeRate)
    .times(oracleData.gasPrice)
    .times(exampleRemoteGas)
    .div(getProtocolExchangeRateScale(protocol).toBigInt());

  return {
    remote,
    exampleRemoteGas,
    exampleRemoteGasCost,
  };
}

function printDifference(
  chain: string,
  provider: MultiProvider,
  original: IgpConfig,
  updated: IgpConfig,
): number {
  let differences = 0;
  for (const [remote, _] of Object.entries(updated.overhead)) {
    const currentCost = exampleCost(remote, provider, original);
    const updatedCost = exampleCost(remote, provider, updated);
    const metadata = provider.getChainMetadata(chain);

    if (currentCost.exampleRemoteGas !== updatedCost.exampleRemoteGas) {
      differences++;
      logger.info(
        `Updated gas: ${chain} -> ${remote}: ${updatedCost.exampleRemoteGas} remote gas cost: ${updatedCost.exampleRemoteGasCost
          .div(new BigNumber(10).pow(metadata.nativeToken?.decimals || 18))
          .toFixed(4)}${metadata.nativeToken?.symbol || ''}`,
      );
    }
  }
  return differences;
}

/**
 * Creates an AltVM signer for the given chain.
 * The private key is loaded from the environment based on the protocol type.
 */
async function createAltVMSigner(
  multiProvider: MultiProvider,
  chain: string,
  privateKey: string,
) {
  const metadata = multiProvider.getChainMetadata(chain);
  const protocolProvider = getProtocolProvider(metadata.protocol);
  return protocolProvider.createSigner(metadata, { privateKey });
}

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
    key,
    filesubmitter,
  } = await withContext(withChains(getArgs()))
    .option('key', {
      type: 'string',
      describe: 'Private key for signing transactions',
      demandOption: true,
    })
    .option('filesubmitter', {
      type: 'string',
      describe: 'In what folder the file submitter stores the transactions',
    }).argv;

  const envConfig = getEnvironmentConfig(environment);

  const providerChains = chains?.length
    ? chains.filter((chain) => !chainsToSkip.includes(chain))
    : envConfig.supportedChainNames.filter(
        (chain) => !chainsToSkip.includes(chain),
      );

  await loadProtocolProviders(
    new Set([ProtocolType.CosmosNative, ProtocolType.Radix, ProtocolType.Aleo]),
  );

  // Get a MultiProvider to access chain metadata
  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    false,
    providerChains,
  );

  // Filter to only AltVM chains (non-Ethereum protocol types that have provider support)
  const altVmChains = providerChains.filter((chain) => {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    return (
      metadata?.protocol !== undefined &&
      metadata.protocol !== ProtocolType.Ethereum &&
      metadata.protocol !== ProtocolType.Starknet &&
      metadata.protocol !== ProtocolType.Sealevel &&
      hasProtocol(metadata.protocol)
    );
  });

  if (altVmChains.length === 0) {
    logger.warn('No AltVM chains found in the specified chains list');
    return;
  }

  logger.info(`Processing AltVM chains: ${altVmChains.join(', ')}`);

  const allChainAddresses = getChainAddresses();

  for (const chain of altVmChains) {
    const igpConfig = envConfig.igp[chain];
    if (!igpConfig) {
      logger.info(`No IGP config found for chain: ${chain}, skipping`);
      continue;
    }

    const chainAddresses = allChainAddresses[chain];
    if (!chainAddresses?.mailbox) {
      logger.warn(
        `No mailbox address found in registry for chain: ${chain}, skipping`,
      );
      continue;
    }

    if (!chainAddresses?.interchainGasPaymaster) {
      logger.warn(
        `No interchainGasPaymaster address found in registry for chain: ${chain}, skipping`,
      );
      continue;
    }

    logger.info(`Processing IGP update for chain: ${chain}`);

    try {
      // Create signer for this chain
      let signer = await createAltVMSigner(multiProvider, chain, key);

      // Create the core module connected to the existing deployment
      const metadata = multiProvider.getChainMetadata(chain);
      const reader = createHookReader(metadata, multiProvider);

      // Read current on-chain config
      logger.info(`Read current IGP config for chain: ${chain}`);
      const actualConfig = await reader.deriveHookConfig(
        chainAddresses.interchainGasPaymaster,
      );

      let differences = printDifference(
        chain,
        multiProvider,
        actualConfig as IgpConfig,
        igpConfig,
      );
      if (differences === 0) {
        logger.info(`No IGP config differences found for chain: ${chain}`);
        continue;
      }
      const expectedConfig = {
        ...actualConfig,
        oracleConfig: igpConfig.oracleConfig,
        overhead: igpConfig.overhead,
      };

      const writer = createHookWriter(metadata, multiProvider, signer, {
        mailbox: chainAddresses.mailbox,
      });

      const { transactions } = await writer.deployOrUpdate({
        actualAddress: chainAddresses.interchainGasPaymaster,
        expectedConfig: expectedConfig as ProviderHookConfig,
      });

      if (transactions.length === 0) {
        logger.info(`No IGP updates needed for chain: ${chain}`);
        continue;
      }

      logger.info(
        `Found ${transactions.length} transactions to update IGP on ${chain}`,
      );

      const { value } = await prompts({
        type: 'confirm',
        name: 'value',
        message: `Confirm you want to update the IGP on ${chain}?\n`,
        initial: false,
      });

      if (!value) {
        logger.info(`Skipping IGP update for chain: ${chain}`);
        continue;
      }

      // Submit transactions
      if (filesubmitter) {
        logger.info(
          `Using file submitter. Transactions will be written to ${filesubmitter}`,
        );
        let json = await Promise.all(
          transactions.map((x) => signer.transactionToPrintableJson(x)),
        );
        const file = `${filesubmitter}/igp-update-${chain}.json`;
        const dir = filesubmitter;
        if (!require('fs').existsSync(dir)) {
          require('fs').mkdirSync(dir, { recursive: true });
        }
        writeFileSync(file, JSON.stringify(json, null, 2));
        logger.info(
          `Transactions written to ${file}. Please sign and submit them manually.`,
        );
      } else {
        const submitter = new AltVMJsonRpcSubmitter(signer, { chain });
        const receipts = await submitter.submit(...transactions);
        logger.info(
          `Successfully updated IGP on ${chain}. ${receipts.length} transaction(s) confirmed.`,
        );
      }
    } catch (error) {
      logger.error(`Failed to update IGP on ${chain}:`, error);
      throw error;
    }
  }

  logger.info('IGP update complete for all AltVM chains');
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
