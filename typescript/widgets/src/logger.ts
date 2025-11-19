import { rootLogger } from '@hyperlane-xyz/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const widgetLogger: any = rootLogger.child({ module: 'widgets' });
