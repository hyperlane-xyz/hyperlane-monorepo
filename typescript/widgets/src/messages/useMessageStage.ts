import { useCallback, useState } from 'react';

import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { fetchWithTimeout } from '@hyperlane-xyz/utils';

import { HYPERLANE_EXPLORER_API_URL } from '../consts.js';
import { widgetLogger } from '../logger.js';
import { queryExplorerForBlock } from '../utils/explorers.js';
import { useInterval } from '../utils/timeout.js';

import {
  MessageStatus,
  PartialMessage,
  MessageStage as Stage,
  StageTimings,
} from './types.js';

const logger = widgetLogger.child({ module: 'useMessageStage' });

const VALIDATION_TIME_EST = 5;
const DEFAULT_BLOCK_TIME_EST = 3;
const DEFAULT_FINALITY_BLOCKS = 3;

interface Params {
  message: PartialMessage | null | undefined;
  multiProvider: MultiProvider;
  explorerApiUrl?: string;
  retryInterval?: number;
}

const defaultTiming: StageTimings = {
  [Stage.Finalized]: null,
  [Stage.Validated]: null,
  [Stage.Relayed]: null,
};

export function useMessageStage({
  message,
  multiProvider,
  explorerApiUrl = HYPERLANE_EXPLORER_API_URL,
  retryInterval = 2000,
}: Params) {
  // Tempting to use react-query here as we did in Explorer but
  // avoiding for now to keep dependencies for this lib minimal

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    stage: Stage;
    timings: StageTimings;
  } | null>(null);

  const fetcher = useCallback(() => {
    // Skip invalid or placeholder messages
    if (!isValidMessage(message)) return;
    // Don't re-run for failing messages
    if (message.status === MessageStatus.Failing && data) return;
    // Don't re-run for pending, validated messages
    if (
      message.status === MessageStatus.Pending &&
      data?.stage === Stage.Validated
    )
      return;

    setIsLoading(true);
    fetchMessageState(message, multiProvider, explorerApiUrl)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e) => setError(e.toString()))
      .finally(() => setIsLoading(false));
  }, [explorerApiUrl, multiProvider, message, data]);

  useInterval(fetcher, retryInterval);

  return {
    stage: data?.stage
      ? data.stage
      : isValidMessage(message)
        ? Stage.Sent
        : Stage.Preparing,
    timings: data?.timings ? data.timings : defaultTiming,
    isLoading,
    error,
  };
}

async function fetchMessageState(
  message: PartialMessage,
  multiProvider: MultiProvider,
  explorerApiUrl: string,
) {
  const {
    status,
    nonce,
    originDomainId,
    destinationDomainId,
    origin,
    destination,
  } = message;
  const { blockNumber: originBlockNumber, timestamp: originTimestamp } = origin;
  const destTimestamp = destination?.timestamp;

  const relayEstimate = Math.floor(
    (await getBlockTimeEst(destinationDomainId, multiProvider)) * 1.5,
  );
  const finalityBlocks = await getFinalityBlocks(originDomainId, multiProvider);
  const finalityEstimate =
    finalityBlocks * (await getBlockTimeEst(originDomainId, multiProvider));

  if (status === MessageStatus.Delivered && destTimestamp) {
    // For delivered messages, just to rough estimates for stages
    // This saves us from making extra explorer calls. May want to revisit in future
    const totalDuration = Math.round((destTimestamp - originTimestamp) / 1000);
    const finalityDuration = Math.max(
      Math.min(finalityEstimate, totalDuration - VALIDATION_TIME_EST),
      1,
    );
    const remaining = totalDuration - finalityDuration;
    const validateDuration = Math.max(
      Math.min(Math.round(remaining * 0.25), VALIDATION_TIME_EST),
      1,
    );
    const relayDuration = Math.max(remaining - validateDuration, 1);
    return {
      stage: Stage.Relayed,
      timings: {
        [Stage.Finalized]: finalityDuration,
        [Stage.Validated]: validateDuration,
        [Stage.Relayed]: relayDuration,
      },
    };
  }

  const latestNonce = await tryFetchLatestNonce(
    originDomainId,
    multiProvider,
    explorerApiUrl,
  );
  if (latestNonce && latestNonce >= nonce) {
    return {
      stage: Stage.Validated,
      timings: {
        [Stage.Finalized]: finalityEstimate,
        [Stage.Validated]: VALIDATION_TIME_EST,
        [Stage.Relayed]: relayEstimate,
      },
    };
  }

  const latestBlock = await tryFetchChainLatestBlock(
    originDomainId,
    multiProvider,
  );
  const finalizedBlock = originBlockNumber + finalityBlocks;
  if (latestBlock && parseInt(latestBlock.number.toString()) > finalizedBlock) {
    return {
      stage: Stage.Finalized,
      timings: {
        [Stage.Finalized]: finalityEstimate,
        [Stage.Validated]: VALIDATION_TIME_EST,
        [Stage.Relayed]: relayEstimate,
      },
    };
  }

  return {
    stage: Stage.Sent,
    timings: {
      [Stage.Finalized]: finalityEstimate,
      [Stage.Validated]: VALIDATION_TIME_EST,
      [Stage.Relayed]: relayEstimate,
    },
  };
}

async function getFinalityBlocks(
  domainId: number,
  multiProvider: MultiProvider,
) {
  const metadata = await multiProvider.getChainMetadata(domainId);
  if (metadata?.blocks?.confirmations) return metadata.blocks.confirmations;
  else return DEFAULT_FINALITY_BLOCKS;
}

async function getBlockTimeEst(domainId: number, multiProvider: MultiProvider) {
  const metadata = await multiProvider.getChainMetadata(domainId);
  return metadata?.blocks?.estimateBlockTime || DEFAULT_BLOCK_TIME_EST;
}

async function tryFetchChainLatestBlock(
  domainId: number,
  multiProvider: MultiProvider,
) {
  const metadata = multiProvider.tryGetChainMetadata(domainId);
  if (!metadata) return null;
  logger.debug(`Attempting to fetch latest block for:`, metadata.name);
  try {
    const block = await queryExplorerForBlock(
      metadata.name,
      multiProvider,
      'latest',
    );
    return block;
  } catch (error) {
    logger.error('Error fetching latest block', error);
    return null;
  }
}

async function tryFetchLatestNonce(
  domainId: number,
  multiProvider: MultiProvider,
  explorerApiUrl: string,
) {
  const metadata = multiProvider.tryGetChainMetadata(domainId);
  if (!metadata) return null;
  logger.debug(`Attempting to fetch nonce for:`, metadata.name);
  try {
    const response = await fetchWithTimeout(
      `${explorerApiUrl}/latest-nonce`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chainId: metadata.chainId }),
      },
      3000,
    );
    const result = await response.json();
    logger.debug(`Found nonce:`, result.nonce);
    return result.nonce;
  } catch (error) {
    logger.error('Error fetching nonce', error);
    return null;
  }
}

function isValidMessage(
  message: PartialMessage | undefined | null,
): message is PartialMessage {
  return !!(
    message &&
    message.originChainId &&
    message.destinationChainId &&
    message.originDomainId &&
    message.destinationDomainId
  );
}
