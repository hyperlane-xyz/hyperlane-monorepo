import { useEffect, useState } from 'react';

import {
  ChainMetadata,
  isBlockExplorerHealthy,
  isRpcHealthy,
} from '@hyperlane-xyz/sdk';
import { timeout } from '@hyperlane-xyz/utils';

import { ChainConnectionType } from '../chains/types.js';

const HEALTH_TEST_TIMEOUT = 5000; // 5s

export function useConnectionHealthTest(
  chainMetadata: ChainMetadata,
  index: number,
  type: ChainConnectionType,
) {
  const [isHealthy, setIsHealthy] = useState<boolean | undefined>(undefined);
  const tester =
    type === ChainConnectionType.RPC ? isRpcHealthy : isBlockExplorerHealthy;

  useEffect(() => {
    // TODO run explorer test through CORS proxy, otherwise it's blocked by browser
    if (type === ChainConnectionType.Explorer) return;
    timeout(tester(chainMetadata, index), HEALTH_TEST_TIMEOUT)
      .then((result) => setIsHealthy(result))
      .catch(() => setIsHealthy(false));
  }, [chainMetadata, index, type, tester]);

  return isHealthy;
}
