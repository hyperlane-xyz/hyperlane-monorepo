import type { MultiProvider } from '@hyperlane-xyz/sdk';

import { useMessage } from './useMessage.js';
import { useMessageStage } from './useMessageStage.js';

interface Params {
  messageId?: string;
  multiProvider: MultiProvider;
  originTxHash?: string;
  explorerApiUrl?: string;
  retryInterval?: number;
}

export function useMessageTimeline(params: Params) {
  const {
    data: message,
    error: msgError,
    isLoading: isMsgLoading,
  } = useMessage(params);
  const {
    stage,
    timings,
    error: stageError,
    isLoading: isStageLoading,
  } = useMessageStage({
    message,
    multiProvider: params.multiProvider,
    retryInterval: params.retryInterval,
  });
  return {
    message,
    stage,
    timings,
    error: msgError || stageError,
    isLoading: isMsgLoading || isStageLoading,
  };
}
