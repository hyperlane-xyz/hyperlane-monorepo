import yargs from 'yargs';

import { AllChains, ChainNameToDomainId } from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { CheckpointStatus, S3Validator } from '../src/agents/aws/validator';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('address', 'address of the validator to inspect')
    .demandOption('address')
    .describe('chain', 'chain of the validator to inspect')
    .choices('chain', AllChains)
    .demandOption('chain')
    .string('address')
    .describe('prospective', 'S3 bucket of the prospective validator')
    .demandOption('prospective')
    .string('prospective')
    .describe('control', 'S3 bucket of the the known (control) validator')
    .demandOption('control')
    .string('control').argv;
}

async function main() {
  const { address, prospective, control, chain } = await getArgs();

  const localDomain = ChainNameToDomainId[chain];

  const controlValidator = new S3Validator(address, localDomain, control);

  const prospectiveValidator = new S3Validator(
    address,
    localDomain,
    prospective,
  );

  const metrics = await prospectiveValidator.compare(controlValidator);

  const statuses = metrics.map((m) => m.status);
  console.log(statuses);

  const violations = metrics
    .map((metric, index) => ({ index, metric }))
    .filter(({ metric }) => metric.status === CheckpointStatus.INVALID)
    .map(({ index, metric }) => `Checkpoint ${index}: ${metric.violation}`);
  console.log(violations);

  const deltas = metrics.filter((m) => m.delta).map((m) => m.delta) as number[];
  console.log(`Median: ${utils.median(deltas)}`);
  console.log(`Mean:   ${utils.mean(deltas)}`);
  console.log(`Stdev:  ${utils.stdDev(deltas)}`);
}

main().catch(console.error);
