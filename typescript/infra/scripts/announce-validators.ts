import { assert } from 'console';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import { AllChains, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';
import { deployEnvToSdkEnv } from '../src/config/environment';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('chain', 'chain on which to register')
    .choices('chain', AllChains)
    .demandOption('chain')
    .describe(
      'location',
      'location, e.g. s3://hyperlane-testnet3-goerli-validator-0/us-east-1',
    )
    .string('location')
    .demandOption('location').argv;
}
async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  // environments union doesn't work well with typescript
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider as any,
  );

  const { chain, location } = await getArgs();

  let announcement;
  if (location.startsWith('s3://')) {
    const validator = await S3Validator.fromStorageLocation(location);
    announcement = await validator.getAnnouncement();
  } else if (location.startsWith('file://')) {
    const announcementFilepath = path.join(
      location.substring(7),
      'announcement.json',
    );
    announcement = JSON.parse(readFileSync(announcementFilepath, 'utf-8'));
  } else {
    throw new Error(`Unknown location type %{location}`);
  }
  // @ts-ignore why?
  const contracts = core.getContracts(chain);
  const validatorAnnounce = contracts.validatorAnnounce;
  const address = announcement.value.validator;
  const announcedLocations =
    await validatorAnnounce.getAnnouncedStorageLocations([address]);
  assert(announcedLocations.length == 1);
  const announced = announcedLocations[0].includes(location);
  if (!announced) {
    const signature = ethers.utils.joinSignature(announcement.signature);
    const signedLocation = announcement.value.storage_location;
    assert(location == signedLocation);
    console.log(`Announcing ${address} checkpoints at ${location}`);
    await validatorAnnounce.announce(address, location, signature);
  } else {
    console.log(`${address} -> ${location} already announced`);
  }
}

main().catch(console.error);
