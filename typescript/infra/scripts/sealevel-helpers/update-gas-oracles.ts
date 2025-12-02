import { confirm } from '@inquirer/prompts';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';
import chalk from 'chalk';

import {
  ChainMap,
  ChainName,
  MultiProtocolProvider,
  SealevelAccountDataWrapper,
  SealevelGasOracle,
  SealevelGasOracleConfig,
  SealevelGasOracleType,
  SealevelGasOverheadConfig,
  SealevelIgpAdapter,
  SealevelIgpData,
  SealevelIgpDataSchema,
  SealevelOverheadIgpAdapter,
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
  SealevelRemoteGasData,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { Domain, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';
import { getSecretRpcEndpoints } from '../../src/agents/index.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import {
  type GasOracleConfigWithOverhead,
  loadAndValidateGasOracleConfig,
} from '../../src/config/gas-oracle.js';
import {
  batchAndSendTransactions,
  formatRemoteGasData,
  loadCoreProgramIds,
  serializeGasOracleDifference,
  svmGasOracleConfigPath,
} from '../../src/utils/sealevel.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { chainIsProtocol } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Fetch and deserialize account states
 */
async function fetchAccountStates(
  connection: Connection,
  igpAccountPda: PublicKey,
  overheadIgpAccountPda: PublicKey,
): Promise<{
  igpAccountData: SealevelIgpData;
  overheadIgpAccountData: SealevelOverheadIgpData;
}> {
  // Fetch current account states
  const igpAccountInfo = await connection.getAccountInfo(igpAccountPda);
  if (!igpAccountInfo) {
    throw new Error(`IGP account not found at ${igpAccountPda.toBase58()}`);
  }

  const overheadIgpAccountInfo = await connection.getAccountInfo(
    overheadIgpAccountPda,
  );
  if (!overheadIgpAccountInfo) {
    throw new Error(
      `Overhead IGP account not found at ${overheadIgpAccountPda.toBase58()}`,
    );
  }

  const igpAccountData = deserializeUnchecked(
    SealevelIgpDataSchema,
    SealevelAccountDataWrapper,
    igpAccountInfo.data,
  ).data as SealevelIgpData;

  const overheadIgpAccountData = deserializeUnchecked(
    SealevelOverheadIgpDataSchema,
    SealevelAccountDataWrapper,
    overheadIgpAccountInfo.data,
  ).data as SealevelOverheadIgpData;

  rootLogger.debug(
    `Current IGP account has ${igpAccountData.gas_oracles.size} gas oracles configured`,
  );
  rootLogger.debug(
    `Current Overhead IGP account has ${overheadIgpAccountData.gas_overheads.size} overheads configured`,
  );

  return { igpAccountData, overheadIgpAccountData };
}

/**
 * Generic function to prompt user before removing unused configs
 */
async function promptForRemoval(
  mpp: MultiProtocolProvider,
  itemType: string,
  chain: ChainName,
  domainsToRemove: Domain[],
): Promise<boolean> {
  if (domainsToRemove.length === 0) {
    return false;
  }

  // Format and log the list of chains to be removed
  rootLogger.info(
    chalk.yellow(
      `\nThe following ${domainsToRemove.length} ${itemType} will be removed from ${chain}:\n${domainsToRemove
        .map((domain) => {
          return `  - ${mpp.getChainName(domain)} (domain ${domain})`;
        })
        .join('\n')}\n`,
    ),
  );

  const shouldContinue = await confirm({
    message: chalk.yellow.bold(
      `Are you sure you want to remove these ${itemType}?`,
    ),
    default: false,
  });

  if (!shouldContinue) {
    rootLogger.info(`Continuing without removing any ${itemType} for ${chain}`);
    return false;
  }

  return true;
}

/**
 * Manage gas oracles - both removal and updates
 */
async function manageGasOracles(
  mpp: MultiProtocolProvider,
  chain: ChainName,
  igpAccountData: SealevelIgpData,
  chainGasOracleConfig: ChainMap<GasOracleConfigWithOverhead>,
  allConfigDomainIds: Set<Domain>,
  igpAdapter: SealevelIgpAdapter,
  igpAccountPda: PublicKey,
  adapter: SvmMultiProtocolSignerAdapter,
  dryRun: boolean,
): Promise<{
  oraclesRemoved: number;
  oraclesUpdated: number;
  oraclesMatched: number;
}> {
  // Step 1: Collect domains to remove
  const domainsToRemove: Domain[] = [];
  for (const [remoteDomain] of igpAccountData.gas_oracles) {
    if (!allConfigDomainIds.has(remoteDomain)) {
      domainsToRemove.push(remoteDomain);
    }
  }

  // Step 2: Collect configs that need updating
  const configsToUpdate: {
    remoteChain: string;
    remoteDomain: number;
    config: SealevelGasOracleConfig;
    remoteGasData: SealevelRemoteGasData;
  }[] = [];
  let oraclesMatched = 0;

  for (const [remoteChain, config] of Object.entries(chainGasOracleConfig)) {
    const remoteMeta = getChain(remoteChain);
    const remoteDomain = remoteMeta.domainId;

    // Check if gas oracle needs updating
    const currentGasOracle = igpAccountData.gas_oracles.get(remoteDomain);
    const remoteGasData = new SealevelRemoteGasData({
      token_exchange_rate: BigInt(config.oracleConfig.tokenExchangeRate),
      gas_price: BigInt(config.oracleConfig.gasPrice),
      token_decimals: config.oracleConfig.tokenDecimals,
    });

    const comparisonResult = igpAdapter.gasOracleMatches(
      currentGasOracle,
      remoteGasData,
    );

    if (!comparisonResult.matches) {
      // Log the gas oracle config with diff if we have the actual values
      if (comparisonResult.actual) {
        rootLogger.info(
          `${chain} -> ${remoteChain}: ${serializeGasOracleDifference(comparisonResult.actual, remoteGasData)}`,
        );
      } else {
        rootLogger.info(
          `${chain} -> ${remoteChain}: ${formatRemoteGasData(remoteGasData)} (new)`,
        );
      }

      const gasOracle = new SealevelGasOracle({
        type: SealevelGasOracleType.RemoteGasData,
        data: remoteGasData,
      });
      const gasOracleConfig = new SealevelGasOracleConfig(
        remoteDomain,
        gasOracle,
      );

      configsToUpdate.push({
        remoteChain,
        remoteDomain,
        config: gasOracleConfig,
        remoteGasData,
      });
    } else {
      oraclesMatched++;
    }

    // Always show example gas cost for this route
    const overheadForExample = config.overhead ?? 200_000;
    const exampleRemoteGas = overheadForExample + 50_000;
    const exampleCostLamports =
      (remoteGasData.token_exchange_rate *
        remoteGasData.gas_price *
        BigInt(exampleRemoteGas)) /
      10n ** 19n; // TOKEN_EXCHANGE_RATE_SCALE

    const { decimals, symbol } = mpp.getChainMetadata(chain).nativeToken!;
    const exampleCost = (Number(exampleCostLamports) / 10 ** decimals).toFixed(
      5,
    );
    rootLogger.info(
      `${chain} -> ${remoteChain}: ${exampleRemoteGas} remote gas cost: ${exampleCost} ${symbol}`,
    );
  }

  // Step 3: Handle removals with user prompt
  let oraclesRemoved = 0;
  if (domainsToRemove.length > 0) {
    if (await promptForRemoval(mpp, 'gas oracles', chain, domainsToRemove)) {
      const removalConfigs = domainsToRemove.map(
        (domain) => new SealevelGasOracleConfig(domain, null),
      );

      await batchAndSendTransactions({
        chain,
        adapter,
        operationName: 'gas oracle removals',
        items: removalConfigs,
        createInstruction: (batch) =>
          igpAdapter.createSetGasOracleConfigsInstruction(
            igpAccountPda,
            adapter.publicKey(),
            batch,
          ),
        formatBatch: (batch) => {
          const startIdx = removalConfigs.indexOf(batch[0]);
          return domainsToRemove
            .slice(startIdx, startIdx + batch.length)
            .map((domain) => mpp.getChainName(domain))
            .join(', ');
        },
        dryRun,
      });
      oraclesRemoved = domainsToRemove.length;
    }
  }

  // Step 4: Handle updates
  let oraclesUpdated = 0;
  if (configsToUpdate.length > 0) {
    await batchAndSendTransactions({
      chain,
      adapter,
      operationName: 'gas oracle updates',
      items: configsToUpdate.map((item) => item.config),
      createInstruction: (batch) =>
        igpAdapter.createSetGasOracleConfigsInstruction(
          igpAccountPda,
          adapter.publicKey(),
          batch,
        ),
      formatBatch: (batch) => {
        const startIdx = configsToUpdate.findIndex(
          (item) => item.config === batch[0],
        );
        return configsToUpdate
          .slice(startIdx, startIdx + batch.length)
          .map((item) => item.remoteChain)
          .join(', ');
      },
      dryRun,
    });
    oraclesUpdated = configsToUpdate.length;
  }

  return { oraclesRemoved, oraclesUpdated, oraclesMatched };
}

/**
 * Manage gas overheads - both removal and updates
 */
async function manageGasOverheads(
  mpp: MultiProtocolProvider,
  chain: ChainName,
  overheadIgpAccountData: SealevelOverheadIgpData,
  chainGasOracleConfig: ChainMap<GasOracleConfigWithOverhead>,
  allConfigDomainIds: Set<Domain>,
  overheadIgpAdapter: SealevelOverheadIgpAdapter,
  overheadIgpAccountPda: PublicKey,
  adapter: SvmMultiProtocolSignerAdapter,
  dryRun: boolean,
): Promise<{
  overheadsRemoved: number;
  overheadsUpdated: number;
  overheadsMatched: number;
}> {
  // Step 1: Collect domains to remove
  const domainsToRemove: Domain[] = [];
  for (const [remoteDomain] of overheadIgpAccountData.gas_overheads) {
    if (!allConfigDomainIds.has(remoteDomain)) {
      domainsToRemove.push(remoteDomain);
    }
  }

  // Step 2: Collect configs that need updating
  const configsToUpdate: {
    remoteChain: string;
    remoteDomain: number;
    config: SealevelGasOverheadConfig;
    targetOverhead: bigint;
    currentOverhead: bigint | undefined;
  }[] = [];
  let overheadsMatched = 0;

  for (const [remoteChain, config] of Object.entries(chainGasOracleConfig)) {
    const remoteMeta = getChain(remoteChain);
    const remoteDomain = remoteMeta.domainId;

    // Check if gas overhead needs updating
    const currentOverheadRaw =
      overheadIgpAccountData.gas_overheads.get(remoteDomain);
    const currentOverhead =
      currentOverheadRaw !== undefined ? BigInt(currentOverheadRaw) : undefined;
    const targetOverhead =
      config.overhead !== undefined ? BigInt(config.overhead) : null;

    const needsOverheadUpdate =
      targetOverhead !== null &&
      (currentOverhead === undefined || currentOverhead !== targetOverhead);

    if (needsOverheadUpdate && targetOverhead !== null) {
      if (currentOverhead === undefined) {
        rootLogger.info(
          `${chain} -> ${remoteChain}: Setting gas overhead to ${targetOverhead} (new)`,
        );
      } else {
        const diff = targetOverhead - currentOverhead;
        const sign = diff >= 0n ? '+' : '';
        rootLogger.info(
          `${chain} -> ${remoteChain}: Updating gas overhead from ${currentOverhead} to ${targetOverhead} (${sign}${diff})`,
        );
      }

      const overheadConfig = new SealevelGasOverheadConfig(
        remoteDomain,
        targetOverhead,
      );

      configsToUpdate.push({
        remoteChain,
        remoteDomain,
        config: overheadConfig,
        targetOverhead,
        currentOverhead,
      });
    } else if (targetOverhead !== null) {
      overheadsMatched++;
    }
  }

  // Step 3: Handle removals with user prompt
  let overheadsRemoved = 0;
  if (domainsToRemove.length > 0) {
    if (await promptForRemoval(mpp, 'gas overheads', chain, domainsToRemove)) {
      const removalConfigs = domainsToRemove.map(
        (domain) => new SealevelGasOverheadConfig(domain, null),
      );

      await batchAndSendTransactions({
        chain,
        adapter,
        operationName: 'gas overhead removals',
        items: removalConfigs,
        createInstruction: (batch) =>
          overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
            overheadIgpAccountPda,
            adapter.publicKey(),
            batch,
          ),
        formatBatch: (batch) => {
          const startIdx = removalConfigs.indexOf(batch[0]);
          return domainsToRemove
            .slice(startIdx, startIdx + batch.length)
            .map((domain) => mpp.getChainName(domain))
            .join(', ');
        },
        dryRun,
      });
      overheadsRemoved = domainsToRemove.length;
    }
  }

  // Step 4: Handle updates
  let overheadsUpdated = 0;
  if (configsToUpdate.length > 0) {
    await batchAndSendTransactions({
      chain,
      adapter,
      operationName: 'gas overhead updates',
      items: configsToUpdate.map((item) => item.config),
      createInstruction: (batch) =>
        overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
          overheadIgpAccountPda,
          adapter.publicKey(),
          batch,
        ),
      formatBatch: (batch) => {
        const startIdx = configsToUpdate.findIndex(
          (item) => item.config === batch[0],
        );
        return configsToUpdate
          .slice(startIdx, startIdx + batch.length)
          .map((item) => item.remoteChain)
          .join(', ');
      },
      dryRun,
    });
    overheadsUpdated = configsToUpdate.length;
  }

  return { overheadsRemoved, overheadsUpdated, overheadsMatched };
}

/**
 * Process a single chain's IGP configuration
 */
async function processChain(
  environment: DeployEnvironment,
  mpp: MultiProtocolProvider,
  chain: ChainName,
  chainGasOracleConfig: ChainMap<GasOracleConfigWithOverhead>,
  adapter: SvmMultiProtocolSignerAdapter,
  dryRun: boolean,
): Promise<{
  chain: string;
  oraclesRemoved: number;
  overheadsRemoved: number;
  oraclesUpdated: number;
  overheadsUpdated: number;
  oraclesMatched: number;
  overheadsMatched: number;
}> {
  rootLogger.debug(`Configuring IGP for ${chain} on ${environment}`);

  const coreProgramIds = loadCoreProgramIds(environment, chain);
  const programId = new PublicKey(coreProgramIds.igp_program_id);
  const igpAccountPda = new PublicKey(coreProgramIds.igp_account);
  const overheadIgpAccountPda = new PublicKey(
    coreProgramIds.overhead_igp_account,
  );

  rootLogger.debug(`Using IGP program ID: ${programId.toBase58()}`);
  rootLogger.debug(`IGP Account: ${igpAccountPda.toBase58()}`);
  rootLogger.debug(`Overhead IGP Account: ${overheadIgpAccountPda.toBase58()}`);
  rootLogger.debug(`Using signer: ${await adapter.address()}`);

  // Create adapters and fetch account states
  const igpAdapter = new SealevelIgpAdapter(chain, mpp, {
    igp: igpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const overheadIgpAdapter = new SealevelOverheadIgpAdapter(chain, mpp, {
    overheadIgp: overheadIgpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const connection = mpp.getSolanaWeb3Provider(chain);
  const { igpAccountData, overheadIgpAccountData } = await fetchAccountStates(
    connection,
    igpAccountPda,
    overheadIgpAccountPda,
  );

  // Get domain IDs for all configured chains
  const allConfigDomainIds = new Set<number>();
  for (const remoteChain of Object.keys(chainGasOracleConfig)) {
    const remoteMeta = getChain(remoteChain);
    allConfigDomainIds.add(remoteMeta.domainId);
  }

  // Execute operations
  const { oraclesRemoved, oraclesUpdated, oraclesMatched } =
    await manageGasOracles(
      mpp,
      chain,
      igpAccountData,
      chainGasOracleConfig,
      allConfigDomainIds,
      igpAdapter,
      igpAccountPda,
      adapter,
      dryRun,
    );

  const { overheadsRemoved, overheadsUpdated, overheadsMatched } =
    await manageGasOverheads(
      mpp,
      chain,
      overheadIgpAccountData,
      chainGasOracleConfig,
      allConfigDomainIds,
      overheadIgpAdapter,
      overheadIgpAccountPda,
      adapter,
      dryRun,
    );

  return {
    chain,
    oraclesRemoved,
    overheadsRemoved,
    oraclesUpdated,
    overheadsUpdated,
    oraclesMatched,
    overheadsMatched,
  };
}

// CLI argument parsing
async function main() {
  const {
    environment,
    chains: chainsArg,
    apply,
  } = await withChains(getArgs()).option('apply', {
    type: 'boolean',
    description: 'Apply changes on-chain (default is dry-run mode)',
    default: false,
  }).argv;

  const dryRun = !apply;

  // Compute default chains based on environment
  const envConfig = getEnvironmentConfig(environment);
  const chains =
    !chainsArg || chainsArg.length === 0
      ? envConfig.supportedChainNames.filter(
          (chain) =>
            chainIsProtocol(chain, ProtocolType.Sealevel) &&
            !chainsToSkip.includes(chain),
        )
      : chainsArg;

  // Initialize Turnkey signer and wrap in adapter (default and only option)
  rootLogger.info('Initializing Turnkey signer from GCP Secret Manager...');
  const turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);
  rootLogger.info(`Signer public key: ${turnkeySigner.publicKey.toBase58()}`);

  rootLogger.info(
    `Configuring IGP for chains: ${chains.join(', ')} on ${environment}`,
  );
  if (dryRun) {
    rootLogger.info('Running in DRY RUN mode - no transactions will be sent');
  }

  // Load and validate configuration
  const configPath = svmGasOracleConfigPath(environment);
  const gasOracleConfig = loadAndValidateGasOracleConfig(configPath);

  // Process all chains in parallel
  const mpp = await envConfig.getMultiProtocolProvider();
  const results = await Promise.all(
    chains.map((chain) => {
      // Wrap Turnkey signer in the adapter for this chain
      const signerAdapter = new SvmMultiProtocolSignerAdapter(
        chain,
        turnkeySigner,
        mpp,
      );

      const chainGasOracleConfig = gasOracleConfig[chain];
      if (!chainGasOracleConfig) {
        // Guard against missing chain configuration
        throw new Error(
          `No gas oracle configuration found for chain '${chain}' in environment '${environment}'. ` +
            `This would cause all existing gas oracles and overheads to be removed. ` +
            `Please ensure the chain is configured in ${configPath}`,
        );
      }
      return processChain(
        environment,
        mpp,
        chain,
        chainGasOracleConfig,
        signerAdapter,
        dryRun,
      );
    }),
  );

  // Print results in a table format
  console.table(results);
}

main().catch((err) => {
  rootLogger.error('Error configuring IGP:', err);
  process.exit(1);
});
