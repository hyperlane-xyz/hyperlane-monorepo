// This file isn't in the src dir so it it's imported before others after import sort
// See bigint hack below and https://github.com/trivago/prettier-plugin-sort-imports/issues/112
import chalk from 'chalk';
import debug from 'debug';

// Workaround for bug in bigint-buffer which solana-web3.js depends on
// https://github.com/no2chem/bigint-buffer/issues/31#issuecomment-1752134062
const defaultWarn = console.warn;
console.warn = (...args: any) => {
  if (
    args &&
    typeof args[0] === 'string' &&
    args[0]?.includes('bigint: Failed to load bindings')
  )
    return;
  defaultWarn(...args);
};

const HYPERLANE_NS = 'hyperlane';

// Default root logger for use in utils/scripts
export const logger = debug(HYPERLANE_NS);
export const error = debug(`${HYPERLANE_NS}:ERROR`);

export function createLogger(namespace: string, isError = false) {
  return isError ? error.extend(namespace) : logger.extend(namespace);
}

// Ensure hyperlane logging is enabled by forcing inclusion of hyperlane namespace
const activeNamespaces = debug.disable();
const otherNamespaces = activeNamespaces
  .split(',')
  .filter((ns) => ns.includes(HYPERLANE_NS));
const hypNamespaces = `${HYPERLANE_NS},${HYPERLANE_NS}:*`;
debug.enable(
  otherNamespaces ? `${otherNamespaces},${hypNamespaces}` : `${hypNamespaces}`,
);

// Change Debug's output format to remove prefixes + postfixes
function formatArgs(this: debug.Debugger, args: any[]) {
  args.push(debug.humanize(this.diff));
  args.pop();
}
debug.formatArgs = formatArgs;

// Colored logs directly to console
export const logBlue = (...args: any) => console.log(chalk.blue(...args));
export const logPink = (...args: any) =>
  console.log(chalk.magentaBright(...args));
export const logGray = (...args: any) => console.log(chalk.gray(...args));
export const logGreen = (...args: any) => console.log(chalk.green(...args));
export const logRed = (...args: any) => console.log(chalk.red(...args));
export const errorRed = (...args: any) => console.error(chalk.red(...args));
export const log = (...args: any) => console.log(...args);
