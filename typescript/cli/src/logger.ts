import chalk from 'chalk';
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

// Colored logs directly to console
export const logBlue = (...args: any) => console.log(chalk.blue(...args));
export const logPink = (...args: any) =>
  console.log(chalk.magentaBright(...args));
export const logGray = (...args: any) => console.log(chalk.gray(...args));
export const logGreen = (...args: any) => console.log(chalk.green(...args));
export const logRed = (...args: any) => console.log(chalk.red(...args));
export const errorRed = (...args: any) => console.error(chalk.red(...args));
export const log = (...args: any) => console.log(...args);
