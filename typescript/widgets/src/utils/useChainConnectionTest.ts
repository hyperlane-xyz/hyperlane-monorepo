import { useEffect, useState } from 'react';

import {
  ChainMetadata,
  isBlockExplorerHealthy,
  isRpcHealthy,
} from '@hyperlane-xyz/sdk';
import { timeout } from '@hyperlane-xyz/utils';

const HEALTH_TEST_TIMEOUT = 5000; // 5s

export function useConnectionHealthTest(
  chainMetadata: ChainMetadata,
  index: number,
  type: 'rpc' | 'explorer',
) {
  const [isHealthy, setIsHealthy] = useState<boolean | undefined>(undefined);
  const tester = type === 'rpc' ? isRpcHealthy : isBlockExplorerHealthy;

  useEffect(() => {
    timeout(tester(chainMetadata, index), HEALTH_TEST_TIMEOUT)
      .then((result) => setIsHealthy(result))
      .catch(() => setIsHealthy(false));
  }, [tester]);

  return isHealthy;
}
