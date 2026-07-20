import { expect } from 'chai';

import { WARP_ROUTE_CHECK_TYPE } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  OWNER_STATUS_SKIP,
  isSkippedOwnerStatusViolation,
  ownerStatusClearTargets,
} from '../scripts/check/owner-status-skip.js';

describe('ownerStatus skip allowlist', () => {
  const best = OWNER_STATUS_SKIP.find(
    (s) => s.warpRouteId === 'BEST/ethereum' && s.chain === 'bsc',
  );
  assert(
    best,
    'expected a BEST/ethereum bsc entry in OWNER_STATUS_SKIP (fixture drifted from allowlist)',
  );

  it('skips the ownerStatus violation for the exact allowlisted owner', () => {
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: best.chain,
        name: `ownerStatus.${best.owner}`,
      }),
    ).to.equal(true);
  });

  it('is case-insensitive on the owner address in the violation name', () => {
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: best.chain,
        name: `ownerStatus.${best.owner.toLowerCase()}`,
      }),
    ).to.equal(true);
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: best.chain,
        name: `ownerStatus.${best.owner.toUpperCase()}`,
      }),
    ).to.equal(true);
  });

  it('does not skip a different owner on the same route+chain', () => {
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: best.chain,
        name: 'ownerStatus.0x0000000000000000000000000000000000000001',
      }),
    ).to.equal(false);
  });

  it('does not skip the allowlisted owner on a different route', () => {
    expect(
      isSkippedOwnerStatusViolation('SOME/other-route', {
        chain: best.chain,
        name: `ownerStatus.${best.owner}`,
      }),
    ).to.equal(false);
  });

  it('does not skip the allowlisted owner on a different chain', () => {
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: 'arbitrum',
        name: `ownerStatus.${best.owner}`,
      }),
    ).to.equal(false);
  });

  it('does not skip non-ownerStatus violations', () => {
    expect(
      isSkippedOwnerStatusViolation(best.warpRouteId, {
        chain: best.chain,
        name: `owner`,
      }),
    ).to.equal(false);
  });

  it('derives one clear target per allowlist entry with matching key fields', () => {
    const targets = ownerStatusClearTargets();
    expect(targets).to.have.length(OWNER_STATUS_SKIP.length);
    for (const [i, skip] of OWNER_STATUS_SKIP.entries()) {
      expect(targets[i]).to.deep.equal({
        warpRouteId: skip.warpRouteId,
        chain: skip.chain,
        contractName: `ownerStatus.${skip.owner}`,
        violationType: WARP_ROUTE_CHECK_TYPE,
      });
    }
  });
});
