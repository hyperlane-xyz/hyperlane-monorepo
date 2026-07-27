// Warp routes whose on-chain config cannot currently be read by our tooling.
// This is not a drift tolerance list: entries only suppress route evaluation
// throws for a known {route, chain} reader/config gap, and should be removed
// once the underlying reader/config gap is fixed.
export interface KnownUnevaluableRoute {
  warpRouteId: string;
  chain: string;
  reason: string;
  // Substrings that must ALL appear in the thrown error for the entry to match.
  // Omit to suppress any evaluation throw for this warp route id (a route-level
  // blacklist), used when the failing leg makes the whole route unevaluable.
  errorSignatures?: string[];
}

const SVM_MULTISIG_READER_ERROR =
  'Multisig ISM reading not supported via artifact manager on SVM';

export const KNOWN_UNEVALUABLE_ROUTES: KnownUnevaluableRoute[] = [
  {
    warpRouteId: 'SOLX/nitro',
    chain: 'solanamainnet',
    reason:
      'SVM messageIdMultisigIsm stores validators per-domain; artifact-manager reader intentionally throws until the reader is implemented.',
    errorSignatures: ['for solanamainnet ', SVM_MULTISIG_READER_ERROR],
  },
  {
    warpRouteId: 'SOLX/nitro',
    chain: 'solaxy',
    reason:
      'SVM messageIdMultisigIsm stores validators per-domain; artifact-manager reader intentionally throws until the reader is implemented.',
    errorSignatures: ['for solaxy ', SVM_MULTISIG_READER_ERROR],
  },
  {
    warpRouteId: 'LYX/lukso',
    chain: 'lukso',
    reason:
      'lukso leg is a native token with no decimals() and the EVM reader asserts "All decimals must be defined"; whole route is unevaluable until the reader tolerates native legs without decimals.',
  },
  {
    warpRouteId: 'USDC/lukso',
    chain: 'lukso',
    reason:
      'lukso legs run older (8.1.2) warp contracts that revert on newer probe selectors (e.g. feeRecipient()/token()), which the reader cannot derive; whole route is unevaluable until the reader tolerates the older ABI.',
  },
];

export function isKnownUnevaluableRoute(
  warpRouteId: string,
  chain: string,
): boolean {
  return KNOWN_UNEVALUABLE_ROUTES.some(
    (route) => route.warpRouteId === warpRouteId && route.chain === chain,
  );
}

export function knownUnevaluableRouteForError(
  warpRouteId: string,
  error: unknown,
): KnownUnevaluableRoute | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return KNOWN_UNEVALUABLE_ROUTES.find(
    (route) =>
      route.warpRouteId === warpRouteId &&
      (route.errorSignatures?.every((sig) => message.includes(sig)) ?? true),
  );
}
