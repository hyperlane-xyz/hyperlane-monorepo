// This file isn't in the src dir so it it's imported before others
// See https://github.com/trivago/prettier-plugin-sort-imports/issues/112

// Workaround for bug in bigint-buffer which solana-web3.js depends on
// https://github.com/no2chem/bigint-buffer/issues/31#issuecomment-1752134062
const defaultWarn = console.warn;
console.warn = (...args) => {
  if (
    args &&
    typeof args[0] === 'string' &&
    args[0]?.includes('bigint: Failed to load bindings')
  )
    return;
  defaultWarn(...args);
};
