/**
 * Verify deployed fastpath aggregation ISMs on each destination chain.
 * Reads each ISM's on-chain sub-modules, validators, and thresholds.
 *
 * Usage:
 *   yarn tsx scripts/validators/fastpath/check-fastpath-isms.ts \
 *     -e mainnet3 \
 *     --ismsFile config/environments/mainnet3/fastpath/isms.json \
 *     [--chains arbitrum base ...]
 */
import { ethers } from 'ethers';

import {
  IAggregationIsm__factory,
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

type SubIsmRow = {
  destination: string;
  ismAddress: string;
  subIsmType: string;
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

  const rows: SubIsmRow[] = [];

  for (const destination of destinations) {
    const ismAddress = ismAddresses[destination];
    if (!ismAddress) {
      rootLogger.warn({ destination }, 'No ISM address found, skipping');
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

    if (moduleType !== ModuleType.AGGREGATION) {
      rootLogger.warn(
        { destination, ismAddress, moduleType },
        'Expected aggregation ISM',
      );
      continue;
    }

    const aggIsm = IAggregationIsm__factory.connect(ismAddress, provider);
    const [subModuleAddresses, aggThreshold] =
      await aggIsm.modulesAndThreshold(dummyMsg);

    for (const subAddress of subModuleAddresses) {
      const subIsm = IInterchainSecurityModule__factory.connect(
        subAddress,
        provider,
      );
      const subType = await subIsm.moduleType();
      const isMultisig =
        subType === ModuleType.MERKLE_ROOT_MULTISIG ||
        subType === ModuleType.MESSAGE_ID_MULTISIG;

      let validators: string[] = [];
      let threshold = 0;
      if (isMultisig) {
        const multisigIsm = IMultisigIsm__factory.connect(subAddress, provider);
        const [v, t] = await multisigIsm.validatorsAndThreshold(dummyMsg);
        validators = [...v];
        threshold = t;
      }

      const validatorsMatch =
        validators.length === DEFAULT_FASTPATH_VALIDATORS.length &&
        DEFAULT_FASTPATH_VALIDATORS.every((v) =>
          validators.some((w) => w.toLowerCase() === v.toLowerCase()),
        );
      const thresholdMatch = threshold === DEFAULT_FASTPATH_THRESHOLD;
      rows.push({
        destination,
        ismAddress,
        subIsmType: ModuleType[subType],
        validators: validators.join(', '),
        threshold,
        ok: isMultisig && validatorsMatch && thresholdMatch ? '✅' : '❌',
      });
    }

    rootLogger.info(
      { destination, aggThreshold, subModules: subModuleAddresses.length },
      'Aggregation ISM checked',
    );
  }

  console.table(rows);

  const failures = rows.filter((r) => r.ok === '❌');
  if (failures.length > 0) {
    rootLogger.error({ count: failures.length }, 'Some sub-ISMs failed checks');
    process.exit(1);
  } else {
    rootLogger.info('All ISMs ok ✅');
  }
}

main().catch(console.error);
