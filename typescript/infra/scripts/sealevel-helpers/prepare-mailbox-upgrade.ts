/**
 * Prepares an SVM mailbox program upgrade and writes the authority-required
 * transactions to a Squads-compatible receipt file.
 *
 * The mailbox writer handles the full upgrade diff. It immediately creates
 * and writes the upgrade buffer with the deployer, then transfers buffer
 * authority to the mailbox's upgrade authority. The returned transactions
 * must be executed by that authority to complete the upgrade.
 *
 * Usage:
 *   source ../hyperlane-registry/.env
 *   pnpm -C typescript/infra tsx \
 *     scripts/sealevel-helpers/prepare-mailbox-upgrade.ts \
 *     -e mainnet3 \
 *     --chain solanamainnet \
 *     --mailbox <MAILBOX_PROGRAM_ADDRESS> \
 *     --upgradeAuthority <SQUADS_VAULT_ADDRESS> \
 *     --out <SQUADS_RECEIPT_PATH> \
 *     --yes
 */
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import path from 'path';

import { address } from '@solana/kit';

import {
  HYPERLANE_SVM_PROGRAM_BYTES,
  SealevelMailboxReader,
  SealevelMailboxWriter,
  SealevelSigner,
  createRpc,
  getProgramUpgradeAuthority,
} from '@hyperlane-xyz/sealevel-sdk';
import {
  ProtocolType,
  assert,
  eqAddressSol,
  rootLogger,
} from '@hyperlane-xyz/utils';
import {
  ensureDirectoryExists,
  writeYamlOrJson,
} from '@hyperlane-xyz/utils/fs';

import { getRegistryForEnvironment } from '../../src/config/chain.js';
import {
  assertProgramBinaryFitsCurrentCapacity,
  deriveProgramDataAddress,
  sanitizeSingleMailboxUpgradeReceiptForSquads,
} from '../../src/utils/mailbox-upgrade.js';
import { getArgs } from '../agent-utils.js';

const logger = rootLogger.child({ module: 'prepare-mailbox-upgrade' });

// Must match package-versioned::PACKAGE_VERSION compiled into the embedded
// HYPERLANE_SVM_PROGRAM_BYTES.mailbox binary.
const TARGET_VERSION = '1.0.0';

async function main(): Promise<void> {
  const argv = await getArgs()
    .option('chain', {
      type: 'string',
      default: 'solanamainnet',
      description: 'Sealevel chain containing the mailbox',
    })
    .option('mailbox', {
      type: 'string',
      demandOption: true,
      description: 'Mailbox program to upgrade',
    })
    .option('upgradeAuthority', {
      type: 'string',
      demandOption: true,
      description: 'Expected current BPF upgrade authority (Squads vault)',
    })
    .option('out', {
      type: 'string',
      demandOption: true,
      description: 'Squads-compatible output receipt file',
    })
    .option('keyEnv', {
      type: 'string',
      default: 'SVM_PRIVATE_KEY',
      description: 'Environment variable containing the buffer payer key',
    })
    .option('yes', {
      type: 'boolean',
      default: false,
      description: 'Confirm buffer creation and on-chain writes',
    })
    .strict().argv;

  const { chain, environment, keyEnv } = argv;
  const mailbox = address(argv.mailbox);
  const expectedUpgradeAuthority = address(argv.upgradeAuthority);
  const registry = await getRegistryForEnvironment(environment, [chain]);
  const metadata = await registry.getChainMetadata(chain);
  assert(metadata, `Chain not found: ${chain}`);
  assert(
    metadata.protocol === ProtocolType.Sealevel,
    `${chain} is not a Sealevel chain`,
  );

  const rpcUrl = metadata.rpcUrls[0]?.http;
  assert(rpcUrl, `No RPC URL configured for ${chain}`);
  const rpc = createRpc(rpcUrl);
  const programBinary = HYPERLANE_SVM_PROGRAM_BYTES.mailbox;
  const programBinarySha256 = createHash('sha256')
    .update(programBinary)
    .digest('hex');

  const current = await new SealevelMailboxReader(rpc).read(mailbox);
  assert(
    current.deployed.domainId === metadata.domainId,
    `Mailbox domain ${current.deployed.domainId} does not match ${chain} domain ${metadata.domainId}`,
  );

  const upgradeAuthority = await getProgramUpgradeAuthority(rpc, mailbox);
  assert(upgradeAuthority, `Mailbox ${mailbox} is immutable`);
  assert(
    eqAddressSol(upgradeAuthority, expectedUpgradeAuthority),
    `Mailbox upgrade authority is ${upgradeAuthority}, expected ${expectedUpgradeAuthority}`,
  );
  assert(
    eqAddressSol(current.config.owner, upgradeAuthority),
    `Mailbox owner ${current.config.owner} differs from upgrade authority ${upgradeAuthority}; refusing to let the mailbox writer transfer upgrade authority`,
  );

  const programDataAddress = address(deriveProgramDataAddress(mailbox));
  const programDataAccount = await rpc
    .getAccountInfo(programDataAddress, { encoding: 'base64' })
    .send();
  assert(
    programDataAccount.value,
    `Mailbox ProgramData account ${programDataAddress} was not found`,
  );
  const currentProgramDataCapacity = assertProgramBinaryFitsCurrentCapacity({
    programBinarySize: programBinary.length,
    programDataAccountSize: Buffer.from(
      programDataAccount.value.data[0],
      'base64',
    ).length,
  });

  const outputPath = path.resolve(argv.out);

  logger.info(
    {
      chain,
      currentVersion: current.config.contractVersion ?? 'legacy',
      currentProgramDataCapacity,
      domainId: current.deployed.domainId,
      environment,
      mailbox,
      outputPath,
      programBinarySha256,
      programBinarySize: programBinary.length,
      targetVersion: TARGET_VERSION,
      upgradeAuthority,
    },
    'Mailbox upgrade plan',
  );

  if (current.config.contractVersion === TARGET_VERSION) {
    logger.info('Mailbox is already at the target version');
    return;
  }

  assert(argv.yes, 'Pass --yes to create and fund the upgrade buffer on-chain');

  const privateKey = process.env[keyEnv];
  assert(privateKey, `Missing buffer payer private key in ${keyEnv}`);
  const signer = await SealevelSigner.connectWithSigner(metadata, privateKey);

  const writer = new SealevelMailboxWriter(
    {
      domainId: metadata.domainId,
      program: { programBytes: programBinary },
    },
    rpc,
    signer,
  );
  const reservation = {
    status: 'preparing',
    chain,
    environment,
    mailbox,
    outputPath,
    bufferPayer: signer.signer.address,
    targetVersion: TARGET_VERSION,
    upgradeAuthority,
    programBinarySha256,
    programBinarySize: programBinary.length,
    currentProgramDataCapacity,
    createdAt: new Date().toISOString(),
    recovery:
      'Preparation did not finish. Inspect the buffer payer transaction history before removing this reservation and retrying.',
  };
  ensureDirectoryExists(outputPath);
  try {
    writeFileSync(outputPath, `${JSON.stringify(reservation, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (error: unknown) {
    throw new Error(
      `Unable to reserve output path ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const authorityTransactions = await writer.update({
    ...current,
    config: {
      ...current.config,
      contractVersion: TARGET_VERSION,
    },
  });
  assert(
    authorityTransactions.length > 0,
    'Mailbox writer produced no upgrade transactions',
  );
  assert(
    authorityTransactions.every(
      (transaction) =>
        transaction.feePayer &&
        eqAddressSol(transaction.feePayer, upgradeAuthority),
    ),
    `Writer returned a transaction not authorized by ${upgradeAuthority}`,
  );

  const printableTransactions = await Promise.all(
    authorityTransactions.map((transaction) =>
      signer.transactionToPrintableJson(transaction),
    ),
  );
  writeYamlOrJson(
    outputPath,
    {
      ...reservation,
      status: 'buffer-prepared',
      authorityTransactions: printableTransactions,
      recovery:
        'The buffer was prepared. If final receipt generation fails, retain this file and use these authority transactions to recover.',
    },
    'json',
  );
  const outputTransactions = sanitizeSingleMailboxUpgradeReceiptForSquads({
    transactions: printableTransactions,
    mailbox,
    upgradeAuthority,
    spillAddress: signer.signer.address,
  });
  writeYamlOrJson(outputPath, outputTransactions, 'json');

  logger.info(
    {
      outputPath,
      programBinarySha256,
      programBinarySize: programBinary.length,
      transactionCount: outputTransactions.length,
      upgradeAuthority,
    },
    'Upgrade buffer prepared and authority transactions written',
  );
  logger.warn(
    'Do not rerun this script. The buffer rent remains locked until the generated upgrade transaction executes.',
  );
}

main().catch((error: unknown) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'Mailbox upgrade preparation failed',
  );
  process.exitCode = 1;
});
