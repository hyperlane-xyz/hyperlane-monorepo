// Contract verification is validated against block explorers, which are
// unreliable across the chains the warp-deploy cron covers: Blockscout-family
// explorers return HTML at the Etherscan-style endpoint the reader uses, some
// chains reject the shared API key, and others rate-limit. The reader surfaces
// these as `actual: error` (not a genuine `unverified`), so they persist as
// false-positive violations that never clear. The cron drops them entirely —
// contract verification is validated at deploy time instead.
//
// contractVerificationStatus violations carry a field path of the form
// `contractVerificationStatus.<proxy|implementation|proxyAdmin>`, so match on
// that prefix (case-insensitively).
export function isContractVerificationViolation(violation: {
  name: string;
}): boolean {
  return violation.name.toLowerCase().includes('contractverificationstatus');
}
