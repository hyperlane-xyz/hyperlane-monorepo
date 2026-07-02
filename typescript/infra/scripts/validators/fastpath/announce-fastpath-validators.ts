/**
 * Announce all fastpath validators (AW, Enigma, Luganodes) on-chain.
 *
 * - AW:        storage locations read from fastpath agent config (S3)
 * - Enigma:    s3://hyperlane-fastpath-validator-enigma-signatures/<chain>
 * - Luganodes: s3://hyperlane-fastpath-validators-signatures/<chain>
 *
 * Usage (all validators, all chains):
 *   yarn tsx scripts/validators/fastpath/announce-fastpath-validators.ts \
 *     -e mainnet3
 *
 * Usage (single chain):
 *   yarn tsx scripts/validators/fastpath/announce-fastpath-validators.ts \
 *     -e mainnet3 --chain arbitrum
 */
import chalk from 'chalk';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { addBufferToGasLimit, assert } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import { getChains } from '../../../config/registry.js';
import { InfraS3Validator } from '../../../src/agents/aws/validator.js';
import { CheckpointSyncerType } from '../../../src/config/agent/validator.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';
import { getAgentConfig, getArgs as getRootArgs } from '../../agent-utils.js';
import { getHyperlaneCore } from '../../core-utils.js';

// External fastpath validators.
// Storage location format: s3://bucket/region/chain
// e.g. https://bucket.s3.eu-central-1.amazonaws.com/polygon/announcement.json
const EXTERNAL_FASTPATH_VALIDATORS = [
  {
    alias: 'Enigma',
    address: '0x93911a19cd8914220f6287d515187e7751817683',
    bucket: 'hyperlane-fastpath-validator-enigma-signatures',
    region: 'eu-central-1',
  },
  {
    alias: 'Luganodes',
    address: '0xf9c6519dbd9a42bc6a60ea8daec3fa3830f40241',
    bucket: 'hyperlane-fastpath-validators-signatures',
    region: 'eu-central-1',
  },
];

function getArgs() {
  return getRootArgs()
    .describe(
      'chain',
      'chain on which to register (defaults to all fastpath chains)',
    )
    .choices('chain', getChains()).argv;
}

type PendingAnnouncement = {
  chain: ChainName;
  storageLocation: string;
  announcement: any;
};

async function main() {
  const { environment, chain: filterChain } = await getArgs();
  const { core, multiProvider } = await getHyperlaneCore(environment);

  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const targetChains = filterChain ? [filterChain] : fastpathChains;
  const evmChains = targetChains.filter(isEthereumProtocolChain);

  const pending: PendingAnnouncement[] = [];

  // AW: read storage locations from the fastpath agent config.
  if (agentConfig.validators) {
    await Promise.all(
      Object.entries(agentConfig.validators.chains)
        .filter(([c]) => evmChains.includes(c))
        .map(async ([c, chainConfig]) => {
          for (const v of chainConfig.validators) {
            if (v.checkpointSyncer.type !== CheckpointSyncerType.S3) continue;
            const contracts = core.getContracts(c);
            const infraValidator = new InfraS3Validator(
              {
                localDomain: multiProvider.getDomainId(c),
                address: v.address,
                mailbox: contracts.mailbox.address,
              },
              v.checkpointSyncer,
            );
            pending.push({
              chain: c,
              storageLocation: infraValidator.storageLocation(),
              announcement: await infraValidator.getSignedAnnouncement(),
            });
          }
        }),
    );
  }

  // Enigma + Luganodes: derive storage location as s3://bucket/<chain>.
  await Promise.all(
    EXTERNAL_FASTPATH_VALIDATORS.flatMap(({ alias, bucket, region }) =>
      evmChains.map(async (c) => {
        const storageLocation = `s3://${bucket}/${region}/${c}`;
        try {
          const infraValidator =
            await InfraS3Validator.fromStorageLocation(storageLocation);
          const announcement = await infraValidator.getSignedAnnouncement();
          pending.push({ chain: c, storageLocation, announcement });
        } catch (err) {
          console.warn(
            chalk.yellow(
              `[${c}] ${alias}: could not read announcement from ${storageLocation}: ${err}`,
            ),
          );
        }
      }),
    ),
  );

  // Submit any that aren't already announced.
  for (const { chain: c, storageLocation, announcement } of pending) {
    try {
      if (!announcement) {
        console.warn(
          chalk.yellow(`[${c}] No announcement at ${storageLocation}`),
        );
        continue;
      }
      const validatorAnnounce = core.getContracts(c).validatorAnnounce;
      const address = announcement.value.validator;
      const loc = announcement.value.storage_location;
      const [announcedLocs] =
        await validatorAnnounce.getAnnouncedStorageLocations([address]);
      const alreadyAnnounced = announcedLocs?.includes(loc) ?? false;

      if (!alreadyAnnounced) {
        const signature = ethers.utils.joinSignature(announcement.signature);
        console.log(chalk.bold(`[${c}] Announcing ${address} at ${loc}`));
        const estimatedGas = await validatorAnnounce.estimateGas.announce(
          address,
          loc,
          signature,
        );
        await validatorAnnounce.announce(address, loc, signature, {
          gasLimit: addBufferToGasLimit(estimatedGas),
          ...multiProvider.getTransactionOverrides(c),
        });
      } else {
        console.log(
          chalk.grey(`[${c}] Already announced ${address} at ${loc}`),
        );
      }
    } catch (error) {
      console.error(
        chalk.bold.red(`Error processing announcement for ${c}:`, error),
      );
    }
  }
}

main().catch(console.error);
