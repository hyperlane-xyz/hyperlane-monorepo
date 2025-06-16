import chalk from 'chalk';
// eslint-disable-next-line
import fs from 'fs';
// eslint-disable-next-line
import path from 'path';

import {
  ChainMap,
  ChainName,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';
import { getArgs } from '../agent-utils.js';

const rootDir = (environment: DeployEnvironment) =>
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    `../../../../rust/sealevel/environments/${environment}/multisig-ism-message-id`,
  );

type SealevelMultisigConfig = {
  type: string;
  threshold: number;
  validators: string[];
};

function getDirectories(source: string): string[] {
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

function checkValidatorsForChain(
  chainName: ChainName,
  config: ChainMap<SealevelMultisigConfig>,
): void {
  rootLogger.info(`\nChain: ${chainName}`);

  const tableData = [];
  const discrepancies: ChainMap<{ missing: string[]; extra: string[] }> = {};

  for (const [chain, multisigConfig] of Object.entries(config)) {
    const validators: string[] = multisigConfig.validators;
    const defaultValidators = defaultMultisigConfigs[chain]?.validators || [];

    const defaultThreshold = defaultMultisigConfigs[chain]?.threshold || 0;
    const sealevelThreshold = multisigConfig.threshold;

    const missingValidators = validators.filter(
      (v: string) => !defaultValidators.map((v) => v.address).includes(v),
    );
    const extraValidators = defaultValidators
      .filter(
        ({ address: validatorAddress }) =>
          !validators.includes(validatorAddress),
      )
      .map((v) => v.address);

    const matchStatus =
      missingValidators.length === 0 && extraValidators.length === 0
        ? '✅'
        : '⚠️';

    tableData.push({
      Chain: chain,
      Default: `${defaultThreshold} of ${defaultValidators.length}`,
      Sealevel: `${sealevelThreshold} of ${validators.length}`,
      Match: matchStatus,
    });

    if (missingValidators.length > 0 || extraValidators.length > 0) {
      discrepancies[chain] = {
        missing: missingValidators,
        extra: extraValidators,
      };
    }
  }

  // eslint-disable-next-line no-console
  console.table(tableData);

  if (Object.keys(discrepancies).length > 0) {
    rootLogger.warn(
      chalk.bold.red(
        `\nDiscrepancies found for ${chainName}. Please review below.`,
      ),
    );

    rootLogger.info(`\nDiscrepancies Summary for ${chainName}:`);
    for (const [chain, { missing, extra }] of Object.entries(discrepancies)) {
      rootLogger.info(`\nChain: ${chain}`);
      if (missing.length > 0) {
        rootLogger.info('In sealevel but not default:');
        missing.forEach((validator) => rootLogger.info(`  - ${validator}`));
      }
      if (extra.length > 0) {
        rootLogger.info('In default but not in sealevel:');
        extra.forEach((validator) => rootLogger.info(`  - ${validator}`));
      }
    }
  } else {
    rootLogger.info(
      chalk.bold.green(
        `\nAll validators match across all chains for ${chainName}.`,
      ),
    );
  }

  rootLogger.info(
    '\n########################################################################################################################\n',
  );
}

async function main() {
  const { environment } = await getArgs().argv;

  const basePath = rootDir(environment);
  const directories = getDirectories(basePath);

  for (const dir of directories) {
    const configPath = path.join(
      basePath,
      dir,
      'hyperlane',
      'multisig-config.json',
    );
    rootLogger.info(`Checking ${configPath}`);
    if (fs.existsSync(configPath)) {
      const config: ChainMap<SealevelMultisigConfig> = JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      );
      checkValidatorsForChain(dir, config);
    } else {
      // eslint-disable-next-line no-console
      console.log(`No multisig-config.json found for ${dir}`);
    }
  }
}

main().catch(rootLogger.error);
