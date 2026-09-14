import type { Logger } from 'pino';

import type { StatusAdaptersByKind } from '../../interfaces/ITokenBridgeStatusAdapter.js';
import { HyperlaneMessageStatusAdapter } from './HyperlaneMessageStatusAdapter.js';
import { LzScanStatusAdapter } from './LzScanStatusAdapter.js';

export function createStatusAdapters(logger: Logger): StatusAdaptersByKind {
  const adapters = [
    new HyperlaneMessageStatusAdapter(
      logger.child({ class: HyperlaneMessageStatusAdapter.name }),
    ),
    new LzScanStatusAdapter({
      logger: logger.child({ class: LzScanStatusAdapter.name }),
    }),
  ];

  return new Map(adapters.map((adapter) => [adapter.kind, adapter]));
}

export { HyperlaneMessageStatusAdapter } from './HyperlaneMessageStatusAdapter.js';
export { LzScanStatusAdapter } from './LzScanStatusAdapter.js';
