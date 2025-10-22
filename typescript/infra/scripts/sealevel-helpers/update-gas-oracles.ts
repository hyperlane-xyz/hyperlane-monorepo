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
  SealevelIgpProgramAdapter,
  SealevelOverheadIgpAdapter,
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
  SealevelRemoteGasData,
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
  ZERO_SALT,
  batchAndSendTransactions,
  calculatePercentDifference,
  formatRemoteGasData,
  loadCoreProgramIds,
  serializeGasOracleDifference,
  svmGasOracleConfigPath,
} from '../../src/utils/sealevel.js';
import { chainIsProtocol, readJSONAtPath } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Fetch and deserialize account states with bump validation
 */
async function fetchAccountStates(
  connection: Connection,
  igpAccountPda: PublicKey,
  overheadIgpAccountPda: PublicKey,
  expectedIgpBump: number,
  expectedOverheadIgpBump: number,
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

  // Validate bump seeds match what's stored on-chain
  if (igpAccountData.bump_seed !== expectedIgpBump) {
    rootLogger.warn(
      chalk.yellow(
        `IGP account bump mismatch! Expected: ${expectedIgpBump}, On-chain: ${igpAccountData.bump_seed}`,
      ),
    );
    throw new Error(
      `IGP account bump validation failed. This may indicate the account is not the canonical PDA.`,
    );
  }

  if (overheadIgpAccountData.bump !== expectedOverheadIgpBump) {
    rootLogger.warn(
      chalk.yellow(
        `Overhead IGP account bump mismatch! Expected: ${expectedOverheadIgpBump}, On-chain: ${overheadIgpAccountData.bump}`,
      ),
    );
    throw new Error(
      `Overhead IGP account bump validation failed. This may indicate the account is not the canonical PDA.`,
    );
  }

  rootLogger.debug(
    `IGP account bump validated: ${igpAccountData.bump_seed} (PDA: ${igpAccountPda.toBase58()})`,
  );
  rootLogger.debug(
    `Overhead IGP account bump validated: ${overheadIgpAccountData.bump} (PDA: ${overheadIgpAccountPda.toBase58()})`,
  );

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
  connection: Connection,
  chain: ChainName,
  igpAccountData: SealevelIgpData,
  chainGasOracleConfig: ChainMap<GasOracleConfigWithOverhead>,
  allConfigDomainIds: Set<Domain>,
  igpAdapter: SealevelIgpAdapter,
  programId: PublicKey,
  igpAccountPda: PublicKey,
  signerKeypair: Keypair,
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
          `${chain} -> ${remoteChain}: ${serializeGasOracleDifference(comparisonResult.actual, remoteGasData, calculatePercentDifference)}`,
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
      if (!dryRun) {
        const removalConfigs = domainsToRemove.map(
          (domain) => new SealevelGasOracleConfig(domain, null),
        );

        await batchAndSendTransactions(
          connection,
          removalConfigs,
          (batch) =>
            igpAdapter.createSetGasOracleConfigsInstruction(
              igpAccountPda,
              signerKeypair.publicKey,
              batch,
            ),
          signerKeypair,
          chain,
          (batch) => {
            const startIdx = removalConfigs.indexOf(batch[0]);
            return domainsToRemove
              .slice(startIdx, startIdx + batch.length)
              .map((domain) => mpp.getChainName(domain))
              .join(', ');
          },
          'gas oracle removals',
        );
      } else {
        domainsToRemove.forEach((domain) => {
          rootLogger.info(`Would remove gas oracle for domain ${domain}`);
        });
      }
      oraclesRemoved = domainsToRemove.length;
    }
  }

  // Step 4: Handle updates
  let oraclesUpdated = 0;
  if (configsToUpdate.length > 0 && !dryRun) {
    await batchAndSendTransactions(
      connection,
      configsToUpdate.map((item) => item.config),
      (batch) =>
        igpAdapter.createSetGasOracleConfigsInstruction(
          igpAccountPda,
          signerKeypair.publicKey,
          batch,
        ),
      signerKeypair,
      chain,
      (batch) => {
        const startIdx = configsToUpdate.findIndex(
          (item) => item.config === batch[0],
        );
        return configsToUpdate
          .slice(startIdx, startIdx + batch.length)
          .map((item) => item.remoteChain)
          .join(', ');
      },
      'gas oracle updates',
    );
    oraclesUpdated = configsToUpdate.length;
  }

  return { oraclesRemoved, oraclesUpdated, oraclesMatched };
}

/**
 * Manage gas overheads - both removal and updates
 */
async function manageGasOverheads(
  mpp: MultiProtocolProvider,
  connection: Connection,
  chain: ChainName,
  overheadIgpAccountData: SealevelOverheadIgpData,
  chainGasOracleConfig: ChainMap<GasOracleConfigWithOverhead>,
  allConfigDomainIds: Set<Domain>,
  overheadIgpAdapter: SealevelOverheadIgpAdapter,
  overheadIgpAccountPda: PublicKey,
  signerKeypair: Keypair,
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
    const currentOverhead =
      overheadIgpAccountData.gas_overheads.get(remoteDomain);
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
      if (!dryRun) {
        const removalConfigs = domainsToRemove.map(
          (domain) => new SealevelGasOverheadConfig(domain, null),
        );

        await batchAndSendTransactions(
          connection,
          removalConfigs,
          (batch) =>
            overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
              overheadIgpAccountPda,
              signerKeypair.publicKey,
              batch,
            ),
          signerKeypair,
          chain,
          (batch) => {
            const startIdx = removalConfigs.indexOf(batch[0]);
            return domainsToRemove
              .slice(startIdx, startIdx + batch.length)
              .map((domain) => mpp.getChainName(domain))
              .join(', ');
          },
          'gas overhead removals',
        );
      } else {
        domainsToRemove.forEach((domain) => {
          rootLogger.info(`Would remove gas overhead for domain ${domain}`);
        });
      }
      overheadsRemoved = domainsToRemove.length;
    }
  }

  // Step 4: Handle updates
  let overheadsUpdated = 0;
  if (configsToUpdate.length > 0 && !dryRun) {
    await batchAndSendTransactions(
      connection,
      configsToUpdate.map((item) => item.config),
      (batch) =>
        overheadIgpAdapter.createSetDestinationGasOverheadsInstruction(
          overheadIgpAccountPda,
          signerKeypair.publicKey,
          batch,
        ),
      signerKeypair,
      chain,
      (batch) => {
        const startIdx = configsToUpdate.findIndex(
          (item) => item.config === batch[0],
        );
        return configsToUpdate
          .slice(startIdx, startIdx + batch.length)
          .map((item) => item.remoteChain)
          .join(', ');
      },
      'gas overhead updates',
    );
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
  keyPath: string,
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
  rootLogger.debug(`Using IGP program ID: ${programId.toBase58()}`);

  // Load keypair
  const keypairData = readJSONAtPath(keyPath);
  const signerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  rootLogger.debug(`Using signer: ${signerKeypair.publicKey.toBase58()}`);

  // Setup connection and derive PDAs with bumps
  const rpcs = await getSecretRpcEndpoints(environment, chain);
  const connection = new Connection(rpcs[0], 'confirmed');

  const [igpAccountPda, expectedIgpBump] =
    SealevelIgpProgramAdapter.deriveIgpAccountPdaWithBump(programId, ZERO_SALT);
  const [overheadIgpAccountPda, expectedOverheadIgpBump] =
    SealevelIgpProgramAdapter.deriveOverheadIgpAccountPdaWithBump(
      programId,
      ZERO_SALT,
    );

  rootLogger.debug(`IGP Account: ${igpAccountPda.toBase58()}`);
  rootLogger.debug(`Overhead IGP Account: ${overheadIgpAccountPda.toBase58()}`);

  // Create adapters and fetch account states
  const igpAdapter = new SealevelIgpAdapter(chain, mpp, {
    igp: igpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const overheadIgpAdapter = new SealevelOverheadIgpAdapter(chain, mpp, {
    overheadIgp: overheadIgpAccountPda.toBase58(),
    programId: programId.toBase58(),
  });

  const { igpAccountData, overheadIgpAccountData } = await fetchAccountStates(
    connection,
    igpAccountPda,
    overheadIgpAccountPda,
    expectedIgpBump,
    expectedOverheadIgpBump,
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
      connection,
      chain,
      igpAccountData,
      chainGasOracleConfig,
      allConfigDomainIds,
      igpAdapter,
      programId,
      igpAccountPda,
      signerKeypair,
      dryRun,
    );

  const { overheadsRemoved, overheadsUpdated, overheadsMatched } =
    await manageGasOverheads(
      mpp,
      connection,
      chain,
      overheadIgpAccountData,
      chainGasOracleConfig,
      allConfigDomainIds,
      overheadIgpAdapter,
      overheadIgpAccountPda,
      signerKeypair,
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
    keyPath,
    apply,
  } = await withChains(getArgs())
    .option('keyPath', {
      type: 'string',
      description: 'Path to Solana keypair JSON file',
      demandOption: true,
      alias: 'k',
    })
    .option('apply', {
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
        keyPath,
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
