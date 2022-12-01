import { ethers } from 'ethers';
import yargs from 'yargs';

import {
  AllChains,
  ChainNameToDomainId,
  hyperlaneCoreAddresses,
} from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('chain', 'chain of the validator to inspect')
    .choices('chain', AllChains)
    .demandOption('chain')
    .describe('address', 'address of the validator to inspect')
    .demandOption('address')
    .string('address')
    .describe('prospective', 'S3 bucket URL of the prospective validator')
    .demandOption('prospective')
    .string('prospective')
    .describe('control', 'S3 bucket URL of the the known (control) validator')
    .demandOption('control')
    .string('control').argv;
}

async function main() {
  const { address, prospective, control, chain } = await getArgs();

  const localDomain = ChainNameToDomainId[chain];
  const mailbox = hyperlaneCoreAddresses[chain].mailbox;

  const controlValidator = new S3Validator(
    ethers.constants.AddressZero,
    localDomain,
    mailbox,
    control,
  );

  const prospectiveValidator = new S3Validator(
    address,
    localDomain,
    mailbox,
    prospective,
  );

  const metrics = await prospectiveValidator.compare(controlValidator);

  console.log(JSON.stringify(metrics, null, 2));
}

main().catch(console.error);
