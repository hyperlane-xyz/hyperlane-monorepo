import { ethers } from 'ethers';
import yargs from 'yargs';

import { AllChains, ChainNameToDomainId } from '@abacus-network/sdk';

// import { utils } from '@abacus-network/utils';
import { S3Validator } from '../src/agents/aws/validator';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('chain', 'chain of the validator to inspect')
    .choices('chain', AllChains)
    .demandOption('chain')
    .describe('address', 'address of the validator to inspect')
    .demandOption('address')
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

  const controlValidator = new S3Validator(
    ethers.constants.AddressZero,
    localDomain,
    control,
  );

  const prospectiveValidator = new S3Validator(
    address,
    localDomain,
    prospective,
  );

  const metrics = await prospectiveValidator.compare(controlValidator);

  console.log(JSON.stringify(metrics, null, 2));
}

main().catch(console.error);
