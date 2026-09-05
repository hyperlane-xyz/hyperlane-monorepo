import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  MultiProtocolProvider,
  Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  getExtraLockboxBalance,
  getManagedLockBoxCollateralInfo,
} from './balance.js';

const lockbox = `0x${'12'.repeat(20)}`;
const collateral = `0x${'34'.repeat(20)}`;
const nextCollateral = `0x${'56'.repeat(20)}`;
const abi = new ethers.utils.Interface([
  'function ERC20() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);
const logger = pino({ enabled: false });

function fixture() {
  const provider = new ethers.providers.StaticJsonRpcProvider(undefined, {
    chainId: 1,
    name: 'test',
  });
  const multiProvider = new MultiProtocolProvider({
    test: {
      name: 'test',
      chainId: 1,
      domainId: 1,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    },
  });
  sinon.stub(multiProvider, 'getEthersV5Provider').returns(provider);
  const token = new Token({
    chainName: 'test',
    standard: TokenStandard.EvmHypVSXERC20,
    addressOrDenom: lockbox,
    decimals: 2,
    symbol: 'TOKEN',
    name: 'Token',
  });
  let address = collateral;
  const calls: Array<{ name: string; to: string | undefined }> = [];
  let failedMethod: string | undefined;
  const failure = new Error('metadata unavailable');
  sinon.stub(provider, 'call').callsFake(async (transaction) => {
    const data = await transaction.data;
    if (data === undefined) throw new Error('Expected contract calldata');
    const decoded = abi.parseTransaction({ data: ethers.utils.hexlify(data) });
    const to = await transaction.to;
    calls.push({ name: decoded.name, to });
    if (decoded.name === failedMethod) throw failure;
    let value: string | number;
    switch (decoded.name) {
      case 'ERC20':
        value = address;
        break;
      case 'balanceOf':
        value = 300;
        break;
      case 'decimals':
        value = 2;
        break;
      case 'symbol':
        value = 'TOKEN';
        break;
      case 'name':
        value =
          to?.toLowerCase() === nextCollateral
            ? 'Next collateral'
            : 'Collateral';
        break;
      default:
        throw new Error(`Unexpected method ${decoded.name}`);
    }
    return abi.encodeFunctionResult(decoded.name, [value]);
  });
  const priceGetter = { tryGetTokenPrice: async () => 2 };
  return {
    multiProvider,
    token,
    priceGetter,
    calls,
    failure,
    setAddress: (next: string) => {
      address = next;
    },
    failMethod: (method?: string) => {
      failedMethod = method;
    },
  };
}

describe('managed-lockbox collateral observation', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('reduces a balance and metadata observation from six reads to five with identical output', async () => {
    const f = fixture();
    const beforeBalance = await getExtraLockboxBalance(
      f.multiProvider,
      f.token,
      f.priceGetter,
      lockbox,
      logger,
    );
    const beforeMetadata = await getManagedLockBoxCollateralInfo(
      f.multiProvider,
      f.token,
      lockbox,
    );
    expect(f.calls).to.have.length(6);
    f.calls.length = 0;
    const balance = await getExtraLockboxBalance(
      f.multiProvider,
      f.token,
      f.priceGetter,
      lockbox,
      logger,
    );
    if (!balance) throw new Error('Expected balance');
    const metadata = await getManagedLockBoxCollateralInfo(
      f.multiProvider,
      f.token,
      lockbox,
      balance.tokenAddress,
    );
    expect(balance).to.deep.equal(beforeBalance);
    expect(metadata).to.deep.equal(beforeMetadata);
    expect(balance).to.deep.equal({
      balance: 3,
      valueUSD: 6,
      tokenAddress: collateral,
    });
    expect(f.calls.map(({ name }) => name)).to.deep.equal([
      'ERC20',
      'balanceOf',
      'decimals',
      'symbol',
      'name',
    ]);
  });

  it('keeps metadata with the observed balance address and refreshes the next sample', async () => {
    const f = fixture();
    const balance = await getExtraLockboxBalance(
      f.multiProvider,
      f.token,
      f.priceGetter,
      lockbox,
      logger,
    );
    if (!balance) throw new Error('Expected balance');
    f.setAddress(nextCollateral);
    expect(
      await getManagedLockBoxCollateralInfo(
        f.multiProvider,
        f.token,
        lockbox,
        balance.tokenAddress,
      ),
    ).to.deep.equal({ tokenName: 'Collateral', tokenAddress: collateral });
    const nextBalance = await getExtraLockboxBalance(
      f.multiProvider,
      f.token,
      f.priceGetter,
      lockbox,
      logger,
    );
    if (!nextBalance) throw new Error('Expected next balance');
    expect(
      await getManagedLockBoxCollateralInfo(
        f.multiProvider,
        f.token,
        lockbox,
        nextBalance.tokenAddress,
      ),
    ).to.deep.equal({
      tokenName: 'Next collateral',
      tokenAddress: nextCollateral,
    });
    expect(f.calls).to.have.length(10);
    f.calls.length = 0;
    expect(
      await getManagedLockBoxCollateralInfo(f.multiProvider, f.token, lockbox),
    ).to.deep.equal({
      tokenName: 'Next collateral',
      tokenAddress: nextCollateral,
    });
    expect(f.calls.map(({ name }) => name)).to.deep.equal([
      'ERC20',
      'decimals',
      'symbol',
      'name',
    ]);
  });

  for (const method of ['decimals', 'symbol', 'name']) {
    it(`retains ${method} failure and fresh retry behavior`, async () => {
      const f = fixture();
      f.failMethod(method);
      try {
        await getManagedLockBoxCollateralInfo(
          f.multiProvider,
          f.token,
          lockbox,
          collateral,
        );
        expect.fail('Expected metadata failure');
      } catch (error) {
        expect(error).to.equal(f.failure);
      }
      f.failMethod();
      expect(
        await getManagedLockBoxCollateralInfo(
          f.multiProvider,
          f.token,
          lockbox,
          collateral,
        ),
      ).to.deep.equal({ tokenName: 'Collateral', tokenAddress: collateral });
      expect(f.calls).to.have.length(6);
    });
  }
});
