import { expect } from 'chai';

import {
  XERC20ExtraBridgeType,
  XERC20Type,
  type XERC20TokenExtraBridgesLimits,
} from '@hyperlane-xyz/sdk';

import { isManagedLockboxExtraBridge } from './Metrics.js';

const limits = {
  type: XERC20Type.Velo,
  bufferCap: '1',
  rateLimitPerSecond: '1',
};

function bridge(
  bridgeType?: XERC20ExtraBridgeType,
): XERC20TokenExtraBridgesLimits {
  return {
    bridgeType,
    lockbox: '0x1111111111111111111111111111111111111111',
    limits,
  };
}

describe('isManagedLockboxExtraBridge', () => {
  it('preserves legacy and explicit managed lockboxes', () => {
    expect(isManagedLockboxExtraBridge(bridge())).to.equal(true);
    expect(
      isManagedLockboxExtraBridge(bridge(XERC20ExtraBridgeType.ManagedLockbox)),
    ).to.equal(true);
  });

  it('excludes CCIP token pools from lockbox-only metrics', () => {
    expect(
      isManagedLockboxExtraBridge(bridge(XERC20ExtraBridgeType.CcipTokenPool)),
    ).to.equal(false);
  });
});
