import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { MANAGED_LOCKBOX_MINIMAL_ABI } from '@hyperlane-xyz/metrics';
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
const tokenAddress = `0x${'12'.repeat(20)}`;
const collateralAddress = `0x${'34'.repeat(20)}`;
const identityInterface = new ethers.utils.Interface([
  ...MANAGED_LOCKBOX_MINIMAL_ABI,
  'function typeAndVersion() view returns (string)',
  'function getToken() view returns (address)',
]);

function bridge(
  bridgeType?: XERC20ExtraBridgeType,
): XERC20TokenExtraBridgesLimits {
  return {
    bridgeType,
    lockbox: `0x${'56'.repeat(20)}`,
    limits,
  };
}

function missingSelector() {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
    error: { code: 3, message: 'execution reverted', data: '0x' },
  });
}

function fixture() {
  const provider = new ethers.providers.StaticJsonRpcProvider(undefined, {
    chainId: 1,
    name: 'test',
  });
  const responses = new Map<string, unknown>([
    ['typeAndVersion', 'BurnWithFromMintTokenPool 1.5.1'],
    ['getToken', tokenAddress],
    ['XERC20', tokenAddress],
    ['ERC20', collateralAddress],
  ]);
  const failures = new Map<string, unknown>();
  const calls: string[] = [];
  sinon.stub(provider, 'call').callsFake(async (transaction) => {
    const data = await transaction.data;
    if (data === undefined) throw new Error('Expected identity calldata');
    expect(await transaction.to).to.equal(bridge().lockbox);
    const { name } = identityInterface.parseTransaction({
      data: ethers.utils.hexlify(data),
    });
    calls.push(name);
    if (failures.has(name)) throw failures.get(name);
    return identityInterface.encodeFunctionResult(name, [responses.get(name)]);
  });
  return { provider, responses, failures, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}

describe('isManagedLockboxExtraBridge', () => {
  afterEach(() => sinon.restore());

  it('preserves explicit managed lockboxes without discovery calls', async () => {
    const f = fixture();
    expect(
      await isManagedLockboxExtraBridge(
        bridge(XERC20ExtraBridgeType.ManagedLockbox),
        f.provider,
      ),
    ).to.equal(true);
    expect(f.calls).to.deep.equal([]);
  });

  it('excludes explicit CCIP token pools without lockbox calls', async () => {
    const f = fixture();
    expect(
      await isManagedLockboxExtraBridge(
        bridge(XERC20ExtraBridgeType.CcipTokenPool),
        f.provider,
      ),
    ).to.equal(false);
    expect(f.calls).to.deep.equal([]);
  });

  it('retains a legacy managed lockbox after positively reading both token getters', async () => {
    const f = fixture();
    f.failures.set('typeAndVersion', missingSelector());
    expect(await isManagedLockboxExtraBridge(bridge(), f.provider)).to.equal(
      true,
    );
    expect(f.calls).to.deep.equal(['typeAndVersion', 'XERC20', 'ERC20']);
  });

  it('retains legacy lockboxes when SmartProvider wraps an empty identity result', async () => {
    const f = fixture();
    f.failures.set(
      'typeAndVersion',
      new Error('All providers failed', {
        cause: new Error('Invalid response from provider'),
      }),
    );
    expect(await isManagedLockboxExtraBridge(bridge(), f.provider)).to.equal(
      true,
    );
    expect(f.calls).to.deep.equal(['typeAndVersion', 'XERC20', 'ERC20']);
  });

  for (const version of [
    'BurnWithFromMintTokenPool 1.5.1',
    'XERC20LockboxTokenPool 1.6.0',
    'SiloedWithUnsiloedXERC20GroupTokenPool 1.6.0',
  ]) {
    it(`excludes legacy ${version} without managed-lockbox reads`, async () => {
      const f = fixture();
      f.responses.set('typeAndVersion', version);
      // CCIP lockbox pools expose the underlying collateral, not the xERC20.
      f.responses.set('getToken', collateralAddress);
      expect(await isManagedLockboxExtraBridge(bridge(), f.provider)).to.equal(
        false,
      );
      expect(f.calls).to.deep.equal(['typeAndVersion', 'getToken']);
    });
  }

  it('rejects an unknown bridge family instead of excluding its metrics', async () => {
    const f = fixture();
    f.responses.set('typeAndVersion', 'OtherContract 1.0.0');
    const error = await rejection(
      isManagedLockboxExtraBridge(bridge(), f.provider),
    );
    expect(error).to.be.instanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).to.include('Unknown extra bridge identity');
    expect(f.calls).to.deep.equal(['typeAndVersion']);
  });

  for (const failure of [
    new Error('RPC unavailable'),
    Object.assign(new Error('missing revert data'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: { code: 'SERVER_ERROR', message: 'HTTP 503' },
    }),
  ]) {
    it(`propagates ${failure.message} without guessing a bridge family`, async () => {
      const f = fixture();
      f.failures.set('typeAndVersion', failure);
      expect(
        await rejection(isManagedLockboxExtraBridge(bridge(), f.provider)),
      ).to.equal(failure);
      expect(f.calls).to.deep.equal(['typeAndVersion']);
    });
  }

  it('propagates a CCIP token getter failure', async () => {
    const f = fixture();
    const failure = new Error('CCIP token unavailable');
    f.failures.set('getToken', failure);
    expect(
      await rejection(isManagedLockboxExtraBridge(bridge(), f.provider)),
    ).to.equal(failure);
  });

  it('propagates a legacy lockbox getter failure', async () => {
    const f = fixture();
    const failure = new Error('Lockbox token unavailable');
    f.failures.set('typeAndVersion', missingSelector());
    f.failures.set('XERC20', failure);
    expect(
      await rejection(isManagedLockboxExtraBridge(bridge(), f.provider)),
    ).to.equal(failure);
  });

  it('rejects a CCIP pool without a token identity', async () => {
    const f = fixture();
    f.responses.set('getToken', ethers.constants.AddressZero);
    const error = await rejection(
      isManagedLockboxExtraBridge(bridge(), f.provider),
    );
    expect(error).to.be.instanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).to.include('Invalid CCIP token pool identity');
  });

  it('rejects a legacy lockbox without an xERC20 identity', async () => {
    const f = fixture();
    f.failures.set('typeAndVersion', missingSelector());
    f.responses.set('XERC20', ethers.constants.AddressZero);
    const error = await rejection(
      isManagedLockboxExtraBridge(bridge(), f.provider),
    );
    expect(error).to.be.instanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).to.include('Invalid managed lockbox identity');
  });
});
