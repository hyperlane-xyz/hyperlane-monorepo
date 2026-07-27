// Warp routes whose on-chain config cannot currently be read by our tooling.
// This is not a drift tolerance list: entries only suppress route evaluation
// throws for an exact {route, chain} pair, and should be removed once the
// underlying reader/config gap is fixed.
export interface KnownUnevaluableRoute {
  warpRouteId: string;
  chain: string;
  reason: string;
}

export const KNOWN_UNEVALUABLE_ROUTES: KnownUnevaluableRoute[] = [
  {
    warpRouteId: 'SOLX/nitro',
    chain: 'solanamainnet',
    reason:
      'SVM messageIdMultisigIsm stores validators per-domain; artifact-manager reader intentionally throws until the reader is implemented.',
  },
  {
    warpRouteId: 'SOLX/nitro',
    chain: 'solaxy',
    reason:
      'SVM messageIdMultisigIsm stores validators per-domain; artifact-manager reader intentionally throws until the reader is implemented.',
  },
];

const SVM_MULTISIG_READER_ERROR =
  'Multisig ISM reading not supported via artifact manager on SVM';

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
      isKnownUnevaluableRoute(warpRouteId, route.chain) &&
      message.includes(`for ${route.chain} `) &&
      message.includes(SVM_MULTISIG_READER_ERROR),
  );
}
