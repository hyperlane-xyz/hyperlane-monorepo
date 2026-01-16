// This file isn't in the src dir so it's imported before others
// See https://github.com/trivago/prettier-plugin-sort-imports/issues/112

// Note: Warning suppression for bigint-buffer and node-fetch deprecation warnings
// is now handled in scripts/ncc.post-bundle.mjs which injects code at the very
// start of the bundle (before any modules are loaded). This ensures the warnings
// are suppressed even during the initial module loading phase.
//
// References:
// - bigint-buffer: https://github.com/no2chem/bigint-buffer/issues/31
// - node-fetch: https://github.com/node-fetch/node-fetch/issues/1000
