import { execSync } from 'child_process';

import { ValidatorAnnounce__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  GcpValidator,
  S3Validator,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// prettier-ignore
const acceptableValidatorVersions: Record<string, string> = {
  // Aug 27 deploy
  '72d498fa984750b9137c1211fef6c80a3e594ce7': 'aug-27-batch',
  // Sep 9 deploy
  'd71dd4e5ed7eb69cc4041813ef444e37d881cdda': 'sep-9-batch',
  // Oct 27 deploy
  '45399a314cec85723bbb5d2360531c96a3aa261e': 'oct-27-batch',
  // Nov 7 deploy
  '75d62ae7bbdeb77730c6d343c4fc1df97a08abe4': 'nov-7-batch',
  // Nov 21 deploy
  'e70431a85965d8d21681e6f4856ed3ac9bd2ba27': 'nov-21-batch',
  // Nov 21 bsquared deploy
  'd834d8147628584acd78a81e344bff76472d707e': 'nov-21-bsquared',
  // Rolled out only to AW infra before 1.0.0, just 1 commit behind 1.0.0
  'a64af8be9a76120d0cfc727bb70660fa07e70cce': 'pre-1.0.0',
  // 1.0.0
  'ffbe1dd82e2452dbc111b6fb469a34fb870da8f1': '1.0.0',
  // Tessellated's Own Build
  '79453fcd972a1e62ba8ee604f0a4999c7b938582': 'tesselated-special-build',
};

type ValidatorInfo = {
  chain: ChainName;
  validator: Address;
  alias: string;
  version: string;
  age?: string;
};

function sortValidatorInfo(a: ValidatorInfo, b: ValidatorInfo) {
  // First sort by alias
  if (a.alias && !b.alias) return -1;
  if (!a.alias && b.alias) return 1;
  if (a.alias && b.alias) {
    const aliasCompare = a.alias.localeCompare(b.alias);
    if (aliasCompare !== 0) return aliasCompare;
  }
  // Then sort by validator address
  return a.chain.localeCompare(b.chain);
}

function getCommitDate(sha: string): string | undefined {
  try {
    // Try to fetch the commit first if we don't have it
    try {
      execSync(`git fetch origin ${sha}`, { stdio: 'ignore' });
    } catch {
      // Ignore fetch errors - commit might be local or unreachable
    }

    // Use %cd for date and customize format with --date=format
    const date = execSync(
      `git show -s --date=format:'%Y-%m-%d %H:%M UTC' --format=%cd ${sha}`,
      { encoding: 'utf-8' },
    ).trim();
    return date;
  } catch {
    return undefined;
  }
}

function getCommitAge(sha: string): string | undefined {
  const commitDateString = getCommitDate(sha);
  if (!commitDateString) {
    return undefined;
  }

  const commitDate = new Date(commitDateString);
  if (isNaN(commitDate.getTime())) {
    return undefined;
  }

  const msToNow = Date.now() - commitDate.getTime();
  const days = Math.floor(msToNow / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (msToNow % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );

  const dayText = days === 1 ? 'day' : 'days';
  const hourText = hours === 1 ? 'hour' : 'hours';
  return days > 0
    ? `${days} ${dayText} ${hours} ${hourText} old`
    : `${hours} ${hourText} old`;
}

async function main() {
  const { environment, chains, showUpdated } = await withChains(getArgs())
    .describe(
      'show-updated',
      'If enabled, prints a table with all updated validators',
    )
    .boolean('show-updated')
    .default('show-updated', false).argv;

  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const mismatchedValidators: ValidatorInfo[] = [];
  const upgradedValidators: ValidatorInfo[] = [];

  // Manually add validator announce for OG Lumia chain deployment
  const lumiaValidatorAnnounce = ValidatorAnnounce__factory.connect(
    '0x989B7307d266151BE763935C856493D968b2affF',
    core.multiProvider.getProvider('lumia'),
  );

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce =
        chain === 'lumia'
          ? lumiaValidatorAnnounce
          : core.getContracts(chain).validatorAnnounce;
      const expectedValidators = defaultMultisigConfigs[chain].validators || [];
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(
          expectedValidators.map((v) => v.address),
        );

      // For each validator on this chain
      for (let i = 0; i < expectedValidators.length; i++) {
        const { address: validator, alias } = expectedValidators[i];
        const location = storageLocations[i][0];

        // Get metadata from each storage location
        try {
          let validatorInstance;
          if (location.startsWith('gs://')) {
            validatorInstance = await GcpValidator.fromStorageLocation(
              location,
            );
          } else {
            validatorInstance = await S3Validator.fromStorageLocation(location);
          }

          const metadata = await validatorInstance.getMetadata();
          const gitSha = metadata?.git_sha;

          if (Object.keys(acceptableValidatorVersions).includes(gitSha)) {
            upgradedValidators.push({
              chain,
              validator,
              alias,
              version: acceptableValidatorVersions[gitSha],
            });
          } else {
            mismatchedValidators.push({
              chain,
              validator,
              alias,
              version: gitSha ? gitSha.slice(0, 7) : 'missing',
              age: getCommitAge(gitSha),
            });
          }
        } catch (error) {
          console.warn(
            `Error getting metadata for validator ${validator} on chain ${chain}: ${error}`,
          );
          mismatchedValidators.push({
            chain,
            validator,
            alias,
            version: `  ???  `,
          });
        }
      }
    }),
  );

  const showUpdatedValidators = () => {
    if (showUpdated) {
      console.log(
        `\n✅ ${upgradedValidators.length} Validators with expected git SHA:`,
      );
      console.table(upgradedValidators.sort(sortValidatorInfo));
    }
  };

  if (mismatchedValidators.length > 0) {
    console.log(
      'Expecting validators to have one of the following git SHA:\n' +
        Object.entries(acceptableValidatorVersions)
          .map(([key, value]) => `  • ${key} (${value})`)
          .join('\n'),
    );
    console.log(
      `\n⚠️ ${mismatchedValidators.length} Validators with mismatched git SHA:`,
    );
    console.table(mismatchedValidators.sort(sortValidatorInfo));

    showUpdatedValidators();
    process.exit(1);
  }

  showUpdatedValidators();
  console.log('\n✅ All validators running expected git SHA!');
  process.exit(0);
}

main().catch(console.error);
