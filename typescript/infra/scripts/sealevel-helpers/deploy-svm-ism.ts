/**
 * Deploy and configure a fresh release-candidate MultisigIsm on SVM chains.
 *
 * Reads validator configs from the existing `hyperlane` context, deploys a new
 * ISM program under the `rc` context, configures it, and hands ownership +
 * upgrade authority to the Squads vault.
 *
 * Uses the deployer key from GCP and embedded program bytes from the svm-sdk.
 *
 * Usage:
 *   pnpm tsx scripts/sealevel-helpers/deploy-svm-ism.ts \
 *     -e mainnet3 \
 *     --chains sonicsvm soon eclipsemainnet
 *
 * Steps per chain:
 *   1. Deploy ISM program from embedded bytes
 *   2. Initialize ISM (access control PDA)
 *   3. Configure validators/thresholds from hyperlane context config
 *   4. Transfer ISM ownership to Squads vault
 *   5. Set upgrade authority to Squads vault
 *   6. Update core/program-ids.json, promote rc -> hyperlane, update registry
 *
 * After this, use update-multisig-ism-config.ts to set the default ISM
 * on the mailbox if the on-chain default differs from the configured one.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';

import bs58 from 'bs58';
import chalk from 'chalk';
import path from 'path';

import {
  HYPERLANE_SVM_PROGRAM_BYTES,
  SealevelMessageIdMultisigIsmWriter,
  SealevelSigner,
  createRpc,
  fetchMultisigIsmAccessControl,
  getMultisigIsmTransferOwnershipInstruction,
  getProgramUpgradeAuthority,
  getSetUpgradeAuthorityInstruction,
} from '@hyperlane-xyz/sealevel-sdk';
import type { SealevelMultisigIsmConfig } from '@hyperlane-xyz/sealevel-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainName, IsmType } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  eqAddressSol,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';
import { address } from '@solana/kit';
import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import { getDeployerKey } from '../../src/agents/key-utils.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { squadsConfigs } from '../../src/config/squads.js';
import {
  SvmMultisigConfigMap,
  loadCoreProgramIds,
  multisigIsmConfigPath,
} from '../../src/utils/sealevel.js';
import { chainIsProtocol, getMonorepoRoot } from '../../src/utils/utils.js';
import {
  Modules,
  getAddresses,
  getAgentConfig,
  getArgs,
  withChains,
  writeAddresses,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'deploy-svm-ism' });

/**
 * Load the SVM deployer key from GCP and return a base58-encoded keypair string
 * suitable for SealevelSigner.connectWithSigner.
 */
async function loadDeployerKey(
  environment: DeployEnvironment,
): Promise<string> {
  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const key = getDeployerKey(agentConfig, 'solanamainnet');
  await key.fetch();
  const keypairBytes = key.privateKeyForProtocol(ProtocolType.Sealevel);
  return bs58.encode(keypairBytes);
}

/**
 * Convert the hyperlane-context multisig config (keyed by chain name with
 * IsmType) into the svm-sdk's SvmMultisigIsmConfig domains map (keyed by
 * domain ID).
 */
function buildDomainMap(
  config: SvmMultisigConfigMap,
): Record<number, { validators: string[]; threshold: number }> {
  const domains: Record<number, { validators: string[]; threshold: number }> =
    {};
  for (const [remoteChain, entry] of Object.entries(config)) {
    const meta = getChain(remoteChain);
    domains[meta.domainId] = {
      validators: entry.validators,
      threshold: entry.threshold,
    };
  }
  return domains;
}

// ── Per-chain processing ───────────────────────────────────────────────

interface ChainResult {
  chain: string;
  programId: string;
  deployed: boolean;
  configured: boolean;
  ownerTransferred: boolean;
  authTransferred: boolean;
  configsUpdated: boolean;
}

async function processChain(
  chain: ChainName,
  environment: DeployEnvironment,
  deployerKeyBase58: string,
): Promise<ChainResult> {
  const result: ChainResult = {
    chain,
    programId: '',
    deployed: false,
    configured: false,
    ownerTransferred: false,
    authTransferred: false,
    configsUpdated: false,
  };

  const coreProgramIds = loadCoreProgramIds(environment, chain);
  const chainMeta = getChain(chain);
  const rpcUrls = chainMeta.rpcUrls
    .map((r) => r.http)
    .filter((url): url is string => !!url);
  assert(rpcUrls.length > 0, `No HTTP RPC URLs configured for ${chain}`);

  const squadsConfig = squadsConfigs[chain];
  if (!squadsConfig) throw new Error(`No Squads config for ${chain}`);
  const vaultAddress = address(squadsConfig.vault);

  // Connect svm-sdk signer
  const signer = await SealevelSigner.connectWithSigner(
    rpcUrls,
    deployerKeyBase58,
  );
  const rpc = createRpc(rpcUrls[0]);
  const deployerAddress = address(signer.getSignerAddress());

  logger.info(chalk.cyan(`\n${'='.repeat(60)}`));
  logger.info(chalk.cyan.bold(`Chain: ${chain}`));
  logger.info(chalk.cyan(`${'='.repeat(60)}`));
  logger.info(chalk.gray(`  Mailbox:      ${coreProgramIds.mailbox}`));
  logger.info(chalk.gray(`  Squads vault: ${vaultAddress}`));
  logger.info(chalk.gray(`  Deployer:     ${deployerAddress}`));

  // ── Step 1-2-3: Deploy + Init + Configure via SvmMessageIdMultisigIsmWriter
  logger.info(chalk.yellow('\n[1-3/6] Deploy, initialize, and configure ISM'));

  const rcDir = path.resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/multisig-ism-message-id/${chain}/${Contexts.ReleaseCandidate}`,
  );
  const programIdsPath = path.join(rcDir, 'program-ids.json');

  // Load validator config from existing hyperlane context
  const configPath = multisigIsmConfigPath(
    environment,
    Contexts.Hyperlane,
    chain,
  );
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const multisigConfig: SvmMultisigConfigMap = readJson(configPath);
  const domains = buildDomainMap(multisigConfig);
  logger.info(
    chalk.gray(
      `  ${Object.keys(domains).length} remote domains from ${configPath}`,
    ),
  );

  // Check if already deployed
  let programAddress: ReturnType<typeof address>;
  if (existsSync(programIdsPath)) {
    const existing = readJson<{ program_id: string }>(programIdsPath);
    programAddress = address(existing.program_id);
    logger.info(chalk.gray(`  Already deployed: ${programAddress}`));
  } else {
    // Use the Writer to deploy + init + configure in one shot
    const writer = new SealevelMessageIdMultisigIsmWriter(rpc, signer);
    const ismConfig: SealevelMultisigIsmConfig = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: [],
      threshold: 0,
      program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.multisigIsm },
      domains,
    };

    const [deployed, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: ismConfig,
    });

    programAddress = deployed.deployed.programId;
    logger.info(
      chalk.green(
        `  Deployed + configured: ${programAddress} (${receipts.length} txs)`,
      ),
    );

    // Save program-ids.json
    if (!existsSync(rcDir)) mkdirSync(rcDir, { recursive: true });
    writeFileSync(
      programIdsPath,
      JSON.stringify({ program_id: String(programAddress) }, null, 2) + '\n',
    );
  }

  result.programId = String(programAddress);
  result.deployed = true;
  result.configured = true;

  // ── Step 4: Transfer ISM ownership to Squads vault ──────────
  logger.info(chalk.yellow('\n[4/6] Transfer ISM ownership'));

  const accessControl = await fetchMultisigIsmAccessControl(
    rpc,
    programAddress,
  );
  if (accessControl?.owner && eqAddressSol(accessControl.owner, vaultAddress)) {
    logger.info(chalk.gray('  Already owned by vault'));
  } else {
    const transferIx = await getMultisigIsmTransferOwnershipInstruction(
      programAddress,
      signer.signer,
      vaultAddress,
    );
    const transferReceipt = await signer.send({ instructions: [transferIx] });
    logger.info(
      chalk.green(
        `  Ownership -> ${vaultAddress}: ${transferReceipt.signature}`,
      ),
    );
  }
  result.ownerTransferred = true;

  // ── Step 5: Set upgrade authority to Squads vault ───────────
  logger.info(chalk.yellow('\n[5/6] Set upgrade authority'));

  const currentAuthority = await getProgramUpgradeAuthority(
    rpc,
    programAddress,
  );
  if (currentAuthority && eqAddressSol(currentAuthority, vaultAddress)) {
    logger.info(chalk.gray('  Already set to vault'));
  } else {
    const authIx = await getSetUpgradeAuthorityInstruction(
      programAddress,
      deployerAddress,
      vaultAddress,
    );
    const authReceipt = await signer.send({ instructions: [authIx] });
    logger.info(
      chalk.green(
        `  Upgrade auth -> ${vaultAddress}: ${authReceipt.signature}`,
      ),
    );
  }
  result.authTransferred = true;

  // ── Step 6: Update config files and registry ────────────────
  logger.info(chalk.yellow('\n[6/6] Update configs and registry'));

  const programIdStr = String(programAddress);

  // 6a. Update core/program-ids.json
  const coreProgramIdsPath = path.resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/${chain}/core/program-ids.json`,
  );
  const updatedCoreProgramIds = {
    ...coreProgramIds,
    multisig_ism_message_id: programIdStr,
  };
  writeFileSync(
    coreProgramIdsPath,
    JSON.stringify(updatedCoreProgramIds, null, 2) + '\n',
  );
  logger.info(chalk.green(`  Updated core/program-ids.json`));

  // 6b. Promote rc -> hyperlane context (copy program-ids.json)
  const hyperlaneDir = path.resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/multisig-ism-message-id/${chain}/${Contexts.Hyperlane}`,
  );
  if (!existsSync(hyperlaneDir)) mkdirSync(hyperlaneDir, { recursive: true });
  const hyperlaneIdsPath = path.join(hyperlaneDir, 'program-ids.json');
  writeFileSync(
    hyperlaneIdsPath,
    JSON.stringify({ program_id: programIdStr }, null, 2) + '\n',
  );
  logger.info(chalk.green(`  Promoted rc -> hyperlane program-ids.json`));

  // 6c. Update registry (interchainSecurityModule)
  const existingRegistryAddresses = getAddresses(environment, Modules.CORE, [
    chain,
  ])[chain];
  writeAddresses(environment, Modules.CORE, {
    [chain]: {
      ...existingRegistryAddresses,
      interchainSecurityModule: programIdStr,
    },
  });
  logger.info(chalk.green(`  Updated registry interchainSecurityModule`));

  result.configsUpdated = true;

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const { environment, chains: chainsArg } = await withChains(getArgs()).argv;

  const envConfig = getEnvironmentConfig(environment);
  const chains =
    !chainsArg || chainsArg.length === 0
      ? envConfig.supportedChainNames.filter(
          (c) =>
            chainIsProtocol(c, ProtocolType.Sealevel) &&
            !chainsToSkip.includes(c),
        )
      : chainsArg;
  assert(chains.length > 0, `No Sealevel chains selected for ${environment}`);
  for (const chain of chains) {
    assert(
      envConfig.supportedChainNames.includes(chain),
      `Unsupported chain for ${environment}: ${chain}`,
    );
    assert(
      chainIsProtocol(chain, ProtocolType.Sealevel),
      `Expected Sealevel chain, got ${chain}`,
    );
    assert(
      !chainsToSkip.includes(chain),
      `Chain is skipped for Sealevel deploys: ${chain}`,
    );
  }

  logger.info(
    chalk.cyan.bold(
      `Deploy rc MultisigIsm on ${chains.join(', ')} (${environment})`,
    ),
  );

  // Load deployer key from GCP
  logger.info('Loading deployer key from GCP...');
  const deployerKeyBase58 = await loadDeployerKey(environment);
  logger.info(chalk.gray('Deployer key loaded'));

  const results: ChainResult[] = [];

  for (const chain of chains) {
    try {
      results.push(await processChain(chain, environment, deployerKeyBase58));
    } catch (error) {
      logger.error(chalk.red(`Failed ${chain}:`), error);
      results.push({
        chain,
        programId: '',
        deployed: false,
        configured: false,
        ownerTransferred: false,
        authTransferred: false,
        configsUpdated: false,
      });
    }
  }

  logger.info(chalk.cyan.bold('\n=== Summary ==='));
  console.table(
    results.map((r) => ({
      chain: r.chain,
      programId: r.programId || '-',
      deploy: r.deployed ? 'ok' : 'FAIL',
      configure: r.configured ? 'ok' : 'FAIL',
      owner: r.ownerTransferred ? 'ok' : 'FAIL',
      authority: r.authTransferred ? 'ok' : 'FAIL',
      configs: r.configsUpdated ? 'ok' : 'FAIL',
    })),
  );

  const failedChains = results
    .filter(
      (r) =>
        !r.deployed ||
        !r.configured ||
        !r.ownerTransferred ||
        !r.authTransferred ||
        !r.configsUpdated,
    )
    .map((r) => r.chain);
  assert(
    failedChains.length === 0,
    `Deployment failed for chains: ${failedChains.join(', ')}`,
  );
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
