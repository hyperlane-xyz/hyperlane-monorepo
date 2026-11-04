import { useCallback, useMemo } from 'react';

import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import { isRpcHealthy } from '@hyperlane-xyz/sdk/providers/rpcHealthTest';
import { timeout } from '@hyperlane-xyz/utils';

import { ChainConnectionType } from '../chains/types.js';
import { useAsyncPolling } from './useAsyncPolling.js';

const HEALTH_TEST_TIMEOUT = 5000; // 5s

export function useConnectionHealthTest(
  chainMetadata: ChainMetadata,
  index: number,
  type: ChainConnectionType,
) {
  const key = useMemo(
    () => ({ chainMetadata, index, type }),
    [chainMetadata, index, type],
  );
  const request = useCallback(async () => {
    // Explorer browser health checks require a CORS proxy.
    if (type === ChainConnectionType.Explorer) return undefined;
    return timeout(isRpcHealthy(chainMetadata, index), HEALTH_TEST_TIMEOUT);
  }, [chainMetadata, index, type]);
  const { data, error } = useAsyncPolling(request, key, null);
  return error ? false : data;
}
