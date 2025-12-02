import { useCallback, useState } from 'react';

import { HYPERLANE_EXPLORER_API_URL } from '../consts.js';
import { widgetLogger } from '../logger.js';
import { executeExplorerQuery } from '../utils/explorers.js';
import { useInterval } from '../utils/timeout.js';

import { ApiMessage, MessageStatus } from './types.js';

const logger = widgetLogger.child({ module: 'useMessage' });

interface Params {
  messageId?: string;
  originTxHash?: string;
  explorerApiUrl?: string;
  retryInterval?: number;
}

// Queries Explorer API to get data for message
// Requires either messageId or originTxHash
export function useMessage({
  messageId,
  originTxHash,
  explorerApiUrl = HYPERLANE_EXPLORER_API_URL,
  retryInterval = 2000,
}: Params) {
  // Tempting to use react-query here as we did in Explorer but
  // avoiding for now to keep dependencies for this lib minimal

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiMessage | null>(null);

  const fetcher = useCallback(() => {
    // Skip if message is already fetched and delivered
    if (data?.status === MessageStatus.Delivered) return;

    setIsLoading(true);
    fetchMessage(explorerApiUrl, messageId, originTxHash)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e) => setError(e.toString()))
      .finally(() => setIsLoading(false));
  }, [explorerApiUrl, messageId, originTxHash, data]);

  useInterval(fetcher, retryInterval);

  return {
    data,
    isLoading,
    error,
  };
}

async function fetchMessage(
  explorerApiUrl: string,
  messageId?: string,
  originTxHash?: string,
): Promise<ApiMessage | null> {
  if (!explorerApiUrl) throw new Error('Explorer API URL required');
  if (!messageId && !originTxHash)
    throw new Error('Either messageId or originTxHash required');

  let url = `${explorerApiUrl}?module=message&action=get-messages`;
  if (messageId) url += `&id=${messageId}`;
  else if (originTxHash) url += `&origin-tx-hash=${originTxHash}`;
  const result = await executeExplorerQuery<ApiMessage[]>(url, 5000);

  if (result.length > 1) {
    logger.warn('More than one message received, should not occur');
    return result[0];
  } else if (result.length === 1) {
    logger.debug('Message data found, id:', result[0].id);
    return result[0];
  } else {
    logger.debug('Message data not found');
    return null;
  }
}
