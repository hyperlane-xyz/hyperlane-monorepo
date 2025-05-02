import { MerkleTreeHook, MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { getValidatorFromStorageLocation } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getArgs, withChainRequired } from '../agent-utils.js';
import { getHyperlaneCore } from '../core-utils.js';

enum ReorgStatus {
  NO_REORG = '✅ NO REORG',
  REORG = '❌ REORG',
  UNKNOWN = '🤷‍♂️ UNKNOWN (could not find canonical checkpoint)',
}

interface CheckpointAssessment {
  checkpointIndex: number;
  signedRoot: string;
  canonicalRoot: string | null;
  canonicalBlock: number | null;
  reorgStatus: ReorgStatus;
}

async function main() {
  const { environment, chain, validator } = await withChainRequired(getArgs())
    .describe('validator', 'Validator address')
    .string('validator')
    .demandOption('validator')
    .alias('v', 'validator').argv;

  const { core, multiProvider, chainAddresses } =
    await getHyperlaneCore(environment);

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
  const validatorInstance =
    await getValidatorFromStorageLocation(storageLocation);
  const latestCheckpointIndex =
    await validatorInstance.getLatestCheckpointIndex();

  let highBlock = await provider.getBlockNumber();

  const checkpointAssessments: CheckpointAssessment[] = [];

  let reorgDetected = false;

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
      rootLogger.error('Signed checkpoint not found', {
        currentCheckpointIndex,
        latestCheckpointIndex,
      });
      continue;
    }

    const { root, index } = signedCheckpoint.value.checkpoint;

    rootLogger.info(
      'Fetched signed checkpoint',
      signedCheckpoint.value.checkpoint,
    );

    rootLogger.info('Searching for canonical checkpoint...', {
      index,
    });
    const canonicalCheckpoint = await getCanonicalCheckpointBinarySearch(
      merkleTreeHook,
      index,
      0,
      highBlock,
    );
    if (!canonicalCheckpoint) {
      rootLogger.warn(
        'Canonical checkpoint not found. This may be expected if there were multiple insertions in one block',
        {
          index,
        },
      );

      checkpointAssessments.push({
        checkpointIndex: index,
        signedRoot: root,
        canonicalRoot: null,
        canonicalBlock: null,
        reorgStatus: ReorgStatus.UNKNOWN,
      });

      continue;
    }
    rootLogger.info('Found canonical checkpoint:', canonicalCheckpoint);
    // We know we're always going to be searching for the next checkpoint in the past
    highBlock = canonicalCheckpoint.block;

    const assessment = {
      checkpointIndex: index,
      signedRoot: root,
      canonicalRoot: canonicalCheckpoint.root,
      canonicalBlock: canonicalCheckpoint.block,
      // to be updated in just a moment
      reorgStatus: ReorgStatus.UNKNOWN,
    };

    if (canonicalCheckpoint.root.toLowerCase() === root.toLowerCase()) {
      rootLogger.info('✅ No reorg detected at checkpoint', {
        index,
        signedCheckpoint: signedCheckpoint.value.checkpoint,
        canonicalCheckpoint: canonicalCheckpoint,
      });
      assessment.reorgStatus = ReorgStatus.NO_REORG;
      checkpointAssessments.push(assessment);
      break;
    } else {
      rootLogger.error('❌❌ Reorg detected at checkpoint ❌❌', {
        index,
        signedCheckpoint: signedCheckpoint.value.checkpoint,
        canonicalCheckpoint: canonicalCheckpoint,
      });
      reorgDetected = true;
      assessment.reorgStatus = ReorgStatus.REORG;
      checkpointAssessments.push(assessment);
    }
  }

  console.table(checkpointAssessments);

  process.exit(reorgDetected ? 1 : 0);
}

async function getCanonicalCheckpointBinarySearch(
  merkleTreeHook: MerkleTreeHook,
  checkpointIndex: number,
  startBlock: number,
  endBlock: number,
): Promise<{ root: string; index: number; block: number } | null> {
  rootLogger.debug('Searching for checkpoint in range', {
    checkpointIndex,
    startBlock,
    endBlock,
  });

  const midBlock = Math.floor((startBlock + endBlock) / 2);
  const midCheckpoint = await merkleTreeHook.latestCheckpoint({
    blockTag: midBlock,
  });
  const [midRoot, midIndex] = midCheckpoint;
  rootLogger.debug('Checkpoint in middle of range found', {
    checkpointIndex,
    startBlock,
    endBlock,
    midBlock,
    midIndex,
    midRoot,
  });
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
