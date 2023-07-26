import debug from 'debug';

const HYPERLANE_NS = 'hyperlane';

// Default root logger for use in utils/scripts
export const logger = debug(HYPERLANE_NS);
export const error = debug(`${HYPERLANE_NS}:ERROR`);

export function createLogger(namespace: string, isError = false) {
  return isError ? error.extend(namespace) : logger.extend(namespace);
}

// Ensure hyperlane logging is enabled
const activeNamespaces = debug.disable();
const otherNamespaces = activeNamespaces
  .split(',')
  .filter((ns) => ns.includes(HYPERLANE_NS));
const hypNamespaces = `${HYPERLANE_NS},${HYPERLANE_NS}:*`;
debug.enable(
  otherNamespaces ? `${otherNamespaces},${hypNamespaces}` : `${hypNamespaces}`,
);
