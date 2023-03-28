import { assert } from 'console';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import { AllChains, ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';
import { CheckpointSyncerType } from '../src/config/agent';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { assertContext } from '../src/utils/utils';

import {
  assertEnvironment,
  getContextAgentConfig,
  getEnvironmentConfig,
} from './utils';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .demandOption('environment')
    .alias('e', 'environment')
    .describe('context', 'deploy context')
    .coerce('context', assertContext)
    .alias('c', 'context')
    .describe('chain', 'chain on which to register')
    .choices('chain', AllChains)
    .describe(
      'location',
      'location, e.g. s3://hyperlane-testnet3-goerli-validator-0/us-east-1',
    )
    .string('location')
    .check(({ context, chain, location }) => {
      const isSet = [!!context, !!chain, !!location];
      if (isSet[0] != isSet[1] && isSet[1] == isSet[2]) {
        return true;
      } else {
        throw new Error('Must specify context OR chain and location');
      }
    }).argv;
}

async function main() {
  const { environment, context, chain, location } = await getArgs();
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();
  // environments union doesn't work well with typescript
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const announcements: {
    storageLocation: string;
    announcement: any;
  }[] = [];
  const chains: ChainName[] = [];
  if (location) {
    chains.push(chain!);
    if (location.startsWith('s3://')) {
      const validator = await S3Validator.fromStorageLocation(location);
      announcements.push({
        storageLocation: validator.storageLocation(),
        announcement: await validator.getAnnouncement(),
      });
    } else if (location.startsWith('file://')) {
      const announcementFilepath = path.join(
        location.substring(7),
        'announcement.json',
      );
      announcements.push({
        storageLocation: location,
        announcement: JSON.parse(readFileSync(announcementFilepath, 'utf-8')),
      });
    } else {
      throw new Error(`Unknown location type %{location}`);
    }
  } else {
    const agentConfig = await getContextAgentConfig(config, context);
    if (agentConfig.validators == undefined) {
      console.warn('No validators provided for context');
      return;
    }
    await Promise.all(
      Object.entries(agentConfig.validators).map(
        async ([chain, validatorChainConfig]) => {
          for (const validatorBaseConfig of validatorChainConfig.validators) {
            if (
              validatorBaseConfig.checkpointSyncer.type ==
              CheckpointSyncerType.S3
            ) {
              const contracts = core.getContracts(chain);
              const localDomain = multiProvider.getDomainId(chain);
              const validator = new S3Validator(
                validatorBaseConfig.address,
                localDomain,
                contracts.mailbox.address,
                validatorBaseConfig.checkpointSyncer.bucket,
                validatorBaseConfig.checkpointSyncer.region,
              );
              announcements.push({
                storageLocation: validator.storageLocation(),
                announcement: await validator.getAnnouncement(),
              });
              chains.push(chain);
            }
          }
        },
      ),
    );
  }

  for (let i = 0; i < announcements.length; i++) {
    const { storageLocation, announcement } = announcements[i];
    if (!announcement) {
      console.info(`No announcement for storageLocation ${storageLocation}`);
    }
    const chain = chains[i];
    const contracts = core.getContracts(chain);
    const validatorAnnounce = contracts.validatorAnnounce;
    const address = announcement.value.validator;
    const location = announcement.value.storage_location;
    const announcedLocations =
      await validatorAnnounce.getAnnouncedStorageLocations([address]);
    assert(announcedLocations.length == 1);
    const announced = announcedLocations[0].includes(location);
    if (!announced) {
      const signature = ethers.utils.joinSignature(announcement.signature);
      console.log(`Announcing ${address} checkpoints at ${location}`);
      await validatorAnnounce.announce(
        address,
        location,
        signature,
        multiProvider.getTransactionOverrides(chain),
      );
    } else {
      console.log(`Already announced ${address} checkpoints at ${location}`);
    }
  }
}

main().catch(console.error);
