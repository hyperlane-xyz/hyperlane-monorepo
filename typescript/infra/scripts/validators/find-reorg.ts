import { MerkleTreeHook, MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { getValidatorFromStorageLocation } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getArgs, withChainRequired } from '../agent-utils.js';
import { getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment, chain, validator } = await withChainRequired(getArgs())
    .describe('validator', 'Validator address')
    .string('validator')
    .demandOption('validator')
    .alias('v', 'validator').argv;

  const { core, multiProvider, chainAddresses } = await getHyperlaneCore(
    environment,
  );

  const provider = multiProvider.getProvider(chain);
  const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
  const merkleTreeHook = MerkleTreeHook__factory.connect(
    chainAddresses[chain].merkleTreeHook,
    multiProvider.getProvider(chain),
  );

  const storageLocations = await validatorAnnounce.getAnnouncedStorageLocations(
    [validator],
  );
  const storageLocation = storageLocations[0][0];
  const validatorInstance = await getValidatorFromStorageLocation(
    storageLocation,
  );
  const latestCheckpointIndex =
    await validatorInstance.getLatestCheckpointIndex();

  let highBlock = await provider.getBlockNumber();

  const checkpointAssessments: {
    index: number;
    signedRoot: string;
    canonicalRoot: string | null;
    canonicalBlock: number | null;
    reorgStatus: string;
  }[] = [];

  // Start from the latest checkpoint and go backwards until we find a non-reorged checkpoint,
  // which we assume to mean that there are no reorgs before that point.
  for (
    let currentCheckpointIndex = latestCheckpointIndex;
    currentCheckpointIndex >= 0;
    currentCheckpointIndex--
  ) {
    const signedCheckpoint = await validatorInstance.getCheckpoint(
      currentCheckpointIndex,
    );
    if (!signedCheckpoint) {
      rootLogger.error(`Checkpoint ${currentCheckpointIndex} not found`);
      continue;
    }

    const { root, index } = signedCheckpoint.value.checkpoint;

    rootLogger.info(`Checking checkpoint ${index} with root ${root}`);

    rootLogger.info(`Searching for canonical checkpoint ${index}...`);
    const canonicalCheckpoint = await getCanonicalCheckpointBinarySearch(
      merkleTreeHook,
      index,
      0,
      highBlock,
    );
    if (!canonicalCheckpoint) {
      rootLogger.info(
        `Canonical checkpoint for ${index} not found. This may be expected if there were multiple insertions in one block`,
      );

      checkpointAssessments.push({
        index,
        signedRoot: root,
        canonicalRoot: null,
        canonicalBlock: null,
        reorgStatus: '🤷‍♂️ UNKNOWN (could not find canonical checkpoint)',
      });

      continue;
    }
    rootLogger.info('Found canonical checkpoint:', canonicalCheckpoint);
    // We know we're always going to be searching for the next checkpoint in the past
    highBlock = canonicalCheckpoint.block;

    const assessment = {
      index,
      signedRoot: root,
      canonicalRoot: canonicalCheckpoint.root,
      canonicalBlock: canonicalCheckpoint.block,
      // to be filled in just a moment
      reorgStatus: '',
    };

    if (canonicalCheckpoint.root.toLowerCase() === root.toLowerCase()) {
      rootLogger.info(`✅ No reorg detected at checkpoint ${index}`);
      assessment.reorgStatus = '✅ NO REORG';
      checkpointAssessments.push(assessment);
      break;
    } else {
      rootLogger.error(`❌ Reorg detected at checkpoint ${index}`);
      rootLogger.error(`❌Canonical root: ${canonicalCheckpoint.root}`);
      rootLogger.error(`❌Signed root: ${root}`);
      assessment.reorgStatus = '❌ REORG';
      checkpointAssessments.push(assessment);
    }
  }

  console.table(checkpointAssessments, [
    'index',
    'signedRoot',
    'canonicalRoot',
    'canonicalBlock',
    'reorgStatus',
  ]);

  process.exit(0);
}

async function getCanonicalCheckpointBinarySearch(
  merkleTreeHook: MerkleTreeHook,
  checkpointIndex: number,
  startBlock: number,
  endBlock: number,
): Promise<{ root: string; index: number; block: number } | null> {
  rootLogger.debug(
    'Searching for checkpoint',
    checkpointIndex,
    'between blocks',
    startBlock,
    'and',
    endBlock,
  );

  const midBlock = Math.floor((startBlock + endBlock) / 2);
  const midCheckpoint = await merkleTreeHook.latestCheckpoint({
    blockTag: midBlock,
  });
  const [midRoot, midIndex] = midCheckpoint;
  rootLogger.debug('Mid checkpoint:', midIndex, midRoot);
  if (midIndex === checkpointIndex) {
    return {
      root: midRoot,
      index: midIndex,
      block: midBlock,
    };
  }

  // This can happen if multiple messages were inserted in the same block -- in this case,
  // a checkpoint for a particular index may have only existed very briefly within a block, but not as
  // the final state of the block.
  if (startBlock === endBlock) {
    return null;
  }

  if (checkpointIndex < midIndex) {
    return getCanonicalCheckpointBinarySearch(
      merkleTreeHook,
      checkpointIndex,
      startBlock,
      midBlock,
    );
  } else {
    return getCanonicalCheckpointBinarySearch(
      merkleTreeHook,
      checkpointIndex,
      midBlock + 1,
      endBlock,
    );
  }
}

main().catch(rootLogger.error);
