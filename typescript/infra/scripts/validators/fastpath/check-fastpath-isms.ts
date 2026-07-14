/**
 * Verify deployed fastpath messageId multisig ISMs on each destination chain.
 * Reads each ISM's on-chain validators and threshold.
 *
 * Usage:
 *   pnpm tsx scripts/validators/fastpath/check-fastpath-isms.ts \
 *     -e mainnet3 \
 *     --ismsFile config/environments/mainnet3/fastpath/isms.json \
 *     [--chains arbitrum base ...]
 */
import { ethers } from 'ethers';

import {
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
} from '@hyperlane-xyz/core';
import { ModuleType } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { getArgs as getBaseArgs, withChains } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

// Fastpath validator addresses (AW, Enigma, Luganodes)
const AW_FASTPATH_VALIDATOR = '0xa9c4c16a4e2cf4628e1bb045cfee9de2f1c3c24a';
const ENIGMA_FASTPATH_VALIDATOR = '0x93911a19cd8914220f6287d515187e7751817683';
const LUGANODES_FASTPATH_VALIDATOR =
  '0xf9c6519dbd9a42bc6a60ea8daec3fa3830f40241';
const DEFAULT_FASTPATH_VALIDATORS = [
  AW_FASTPATH_VALIDATOR,
  ENIGMA_FASTPATH_VALIDATOR,
  LUGANODES_FASTPATH_VALIDATOR,
];
const DEFAULT_FASTPATH_THRESHOLD = 2;

// Non-zero dummy address — avoids the addressToBytes zero-check in formatMessage.
const DUMMY_ADDRESS_BYTES32 = ethers.utils.hexZeroPad('0x01', 32);

function buildDummyMessage(originDomain: number, destDomain: number): string {
  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      0,
      0,
      originDomain,
      DUMMY_ADDRESS_BYTES32,
      destDomain,
      DUMMY_ADDRESS_BYTES32,
      '0x',
    ],
  );
}

function getArgs() {
  return withChains(getBaseArgs())
    .describe('ismsFile', 'path to JSON file mapping chain -> ISM address')
    .string('ismsFile')
    .demandOption('ismsFile')
    .alias('f', 'ismsFile');
}

type IsmRow = {
  destination: string;
  ismAddress: string;
  validators: string;
  threshold: number;
  ok: string;
};

async function main() {
  const { environment, chains, ismsFile } = await getArgs().argv;

  const ismAddresses = readJson<Record<string, string>>(ismsFile);

  const destinations =
    chains && chains.length > 0 ? chains : Object.keys(ismAddresses);

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  const rows: IsmRow[] = [];

  for (const destination of destinations) {
    const ismAddress = ismAddresses[destination];
    if (!ismAddress) {
      rootLogger.warn({ destination }, 'No ISM address found');
      rows.push({
        destination,
        ismAddress: '',
        validators: '',
        threshold: 0,
        ok: '❌',
      });
      continue;
    }

    const provider = multiProvider.getProvider(destination);
    const destDomain = multiProvider.getDomainId(destination);
    // Static ISMs ignore message content — any origin domain works.
    const dummyMsg = buildDummyMessage(1, destDomain);

    const topIsm = IInterchainSecurityModule__factory.connect(
      ismAddress,
      provider,
    );
    const moduleType = await topIsm.moduleType();

    if (moduleType !== ModuleType.MESSAGE_ID_MULTISIG) {
      rootLogger.warn(
        { destination, ismAddress, moduleType },
        'Expected messageId multisig ISM',
      );
      rows.push({
        destination,
        ismAddress,
        validators: '',
        threshold: 0,
        ok: '❌',
      });
      continue;
    }

    const multisigIsm = IMultisigIsm__factory.connect(ismAddress, provider);
    const [validators, threshold] =
      await multisigIsm.validatorsAndThreshold(dummyMsg);

    const validatorsMatch =
      validators.length === DEFAULT_FASTPATH_VALIDATORS.length &&
      DEFAULT_FASTPATH_VALIDATORS.every((v) =>
        validators.some((w) => w.toLowerCase() === v.toLowerCase()),
      );
    const thresholdMatch = threshold === DEFAULT_FASTPATH_THRESHOLD;
    rows.push({
      destination,
      ismAddress,
      validators: [...validators].join(', '),
      threshold,
      ok: validatorsMatch && thresholdMatch ? '✅' : '❌',
    });

    rootLogger.info({ destination }, 'MessageId multisig ISM checked');
  }

  console.table(rows);

  if (rows.length === 0) {
    rootLogger.error('No ISM checks completed');
    process.exitCode = 1;
    return;
  }

  const failures = rows.filter((r) => r.ok === '❌');
  if (failures.length > 0) {
    rootLogger.error({ count: failures.length }, 'Some ISMs failed checks');
    process.exitCode = 1;
  } else {
    rootLogger.info('All ISMs ok ✅');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
