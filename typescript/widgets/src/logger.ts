import { Logger, rootLogger } from '@hyperlane-xyz/utils';

export const widgetLogger: Logger = rootLogger.child({ module: 'widgets' });
