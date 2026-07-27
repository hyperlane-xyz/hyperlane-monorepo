import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import {
  KNOWN_UNEVALUABLE_ROUTES,
  isKnownUnevaluableRoute,
  knownUnevaluableRouteForError,
} from '../scripts/check/known-unevaluable-routes.js';

describe('known unevaluable routes allowlist', () => {
  const solx = KNOWN_UNEVALUABLE_ROUTES.find(
    (route) =>
      route.warpRouteId === 'SOLX/nitro' && route.chain === 'solanamainnet',
  );
  assert(
    solx,
    'expected a SOLX/nitro solanamainnet entry in KNOWN_UNEVALUABLE_ROUTES',
  );

  it('matches the exact allowlisted route and chain', () => {
    expect(isKnownUnevaluableRoute(solx.warpRouteId, solx.chain)).to.equal(
      true,
    );
  });

  it('does not match a different route or chain', () => {
    expect(isKnownUnevaluableRoute('OTHER/route', solx.chain)).to.equal(false);
    expect(isKnownUnevaluableRoute(solx.warpRouteId, 'ethereum')).to.equal(
      false,
    );
  });

  it('matches the known SVM multisig reader error for the allowlisted chain', () => {
    const match = knownUnevaluableRouteForError(
      solx.warpRouteId,
      new Error(
        `Failed to derive altVM warp config for ${solx.chain} at router: Multisig ISM reading not supported via artifact manager on SVM (different config shape). Use SvmMessageIdMultisigIsmReader directly.`,
      ),
    );
    expect(match).to.deep.equal(solx);
  });

  it('does not match unrelated errors on the same route and chain', () => {
    expect(
      knownUnevaluableRouteForError(
        solx.warpRouteId,
        new Error(`Failed to derive altVM warp config for ${solx.chain}: RPC`),
      ),
    ).to.equal(undefined);
  });
});
