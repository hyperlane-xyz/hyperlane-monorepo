import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  ChainMap,
  ChainName,
  KeypairSvmTransactionSigner,
  SvmMultiProtocolSignerAdapter,
  SvmTransactionSigner,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  ProtocolType,
  assert,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getDeployerKey } from '../../src/agents/key-utils.js';
import { squadsConfigs } from '../../src/config/squads.js';
import { executePendingTransactions } from '../../src/tx/utils.js';
import {
  SquadTxStatus,
  executeProposal,
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { getAgentConfig, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

// Chains whose Turnkey deployer account is not funded yet, so we fall back to
// the regular GCP-backed Sealevel deployer keypair for Squads execution.
const KEYPAIR_SIGNER_CHAINS = new Set<ChainName>(['solaxy']);

async function getKeypairSealevelDeployerSigner(): Promise<KeypairSvmTransactionSigner> {
  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  // Pass 'solanamainnet' so we fetch the Sealevel-format deployer key
  // (base64-encoded Solana CLI byte array) rather than the default EVM hex key.
  const key = getDeployerKey(agentConfig, 'solanamainnet');
  await key.fetch();
  return new KeypairSvmTransactionSigner(
    key.privateKeyForProtocol(ProtocolType.Sealevel),
  );
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains } = await withChains(
    yargs(process.argv.slice(2)),
    Object.keys(squadsConfigs),
  ).argv;

  const squadChains = Object.keys(squadsConfigs);
  const chainsToCheck = chains || squadChains;

  if (chainsToCheck.length === 0) {
    rootLogger.error('No chains provided');
    process.exit(1);
  }

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Status Monitor'));
  rootLogger.info(
    chalk.blue(
      `Checking squads proposals on chains: ${chainsToCheck.join(', ')}`,
    ),
  );

  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

  const pendingProposals = await getPendingProposalsForChains(
    chainsToCheck,
    mpp,
  );

  if (pendingProposals.length === 0) {
    rootLogger.info(chalk.green('No pending proposals found!'));
    process.exit(0);
  }

  logProposals(pendingProposals);

  // Filter for approved proposals that can be executed
  const executableProposals = pendingProposals.filter(
    (p) => p.status === SquadTxStatus.APPROVED,
  );

  if (executableProposals.length === 0) {
    rootLogger.info(chalk.green('No proposals ready to execute!'));
    process.exit(0);
  }

  const shouldExecute = await confirm({
    message: 'Execute proposals?',
    default: false,
  });

  if (!shouldExecute) {
    rootLogger.info(
      chalk.blue(
        `${executableProposals.length} proposal(s) available for execution`,
      ),
    );
    process.exit(0);
  }

  rootLogger.info(chalk.blueBright('Executing proposals...'));

  const uniqueChains = Array.from(
    new Set(executableProposals.map((p) => p.chain)),
  );
  const needsTurnkey = uniqueChains.some((c) => !KEYPAIR_SIGNER_CHAINS.has(c));
  const needsKeypair = uniqueChains.some((c) => KEYPAIR_SIGNER_CHAINS.has(c));

  let turnkeySigner: SvmTransactionSigner | undefined;
  if (needsTurnkey) {
    rootLogger.info('Initializing Turnkey signer...');
    turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);
  }

  let keypairSigner: SvmTransactionSigner | undefined;
  if (needsKeypair) {
    rootLogger.info(
      `Initializing GCP deployer keypair signer for chains: ${[...KEYPAIR_SIGNER_CHAINS].join(', ')}`,
    );
    keypairSigner = await getKeypairSealevelDeployerSigner();
  }

  // Create signers for each chain (keyed by chain name)
  const signersByChain: ChainMap<SvmMultiProtocolSignerAdapter> = {};
  for (const chain of uniqueChains) {
    const signer = KEYPAIR_SIGNER_CHAINS.has(chain)
      ? keypairSigner
      : turnkeySigner;
    assert(signer, `No signer initialized for chain ${chain}`);
    signersByChain[chain] = new SvmMultiProtocolSignerAdapter(
      chain,
      signer,
      mpp,
    );
  }

  await executePendingTransactions(
    executableProposals,
    (p) => p.shortTxHash,
    (p) => p.chain,
    (p) => executeProposal(p.chain, mpp, p.nonce, signersByChain[p.chain]),
  );

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
