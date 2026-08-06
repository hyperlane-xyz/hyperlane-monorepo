/**
 * Announce all fastpath validators (AW, Enigma, Luganodes) on-chain.
 *
 * - AW:        storage locations read from fastpath agent config (S3 or GCS)
 * - Enigma:    s3://hyperlane-fastpath-validator-enigma-signatures/<chain>
 * - Luganodes: s3://hyperlane-fastpath-validators-signatures/<chain>
 *
 * Usage (all validators, all chains):
 *   pnpm tsx scripts/validators/fastpath/announce-fastpath-validators.ts \
 *     -e mainnet3
 *
 * Usage (single chain):
 *   pnpm tsx scripts/validators/fastpath/announce-fastpath-validators.ts \
 *     -e mainnet3 --chain arbitrum
 */
import chalk from 'chalk';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { addBufferToGasLimit } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import { getChains } from '../../../config/registry.js';
import { InfraS3Validator } from '../../../src/agents/aws/validator.js';
import { InfraGcsValidator } from '../../../src/agents/gcp/validator.js';
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
  const failures: string[] = [];

  // AW: read storage locations from the fastpath agent config.
  if (agentConfig.validators) {
    await Promise.all(
      Object.entries(agentConfig.validators.chains)
        .filter(([c]) => evmChains.includes(c))
        .map(async ([c, chainConfig]) => {
          const contracts = core.getContracts(c);

          for (const [idx, v] of chainConfig.validators.entries()) {
            const validatorConfig = {
              localDomain: multiProvider.getDomainId(c),
              address: v.address,
              mailbox: contracts.mailbox.address,
            };

            // createChainValidatorBaseConfigs always materializes an S3
            // checkpointSyncer here regardless of context — the real
            // deployed validator only switches to GCS at deploy time inside
            // ValidatorConfigHelper#configForValidator, which this static
            // config lookup never runs. So checkpointSyncer.type is never
            // actually Gcs here; derive the GCS bucket/folder directly from
            // agentConfig.gcp instead, mirroring #configForValidator's naming.
            if (agentConfig.gcp) {
              const bucketName = `${Contexts.FastPath}-${environment}-validator-${idx}`;
              const infraValidator = new InfraGcsValidator(validatorConfig, {
                bucket: bucketName,
                folder: c,
                caching: true,
              });
              pending.push({
                chain: c,
                storageLocation: infraValidator.storageLocation(),
                announcement: await infraValidator.getSignedAnnouncement(),
              });
            } else if (v.checkpointSyncer.type === CheckpointSyncerType.S3) {
              const infraValidator = new InfraS3Validator(
                validatorConfig,
                v.checkpointSyncer,
              );
              pending.push({
                chain: c,
                storageLocation: infraValidator.storageLocation(),
                announcement: await infraValidator.getSignedAnnouncement(),
              });
            }
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
          failures.push(`${alias}@${c}`);
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
        failures.push(c);
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
      failures.push(c);
    }
  }

  if (failures.length > 0) {
    console.error(
      chalk.bold.red(`\n${failures.length} failure(s): ${failures.join(', ')}`),
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
