import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import sinon from 'sinon';

import { test1, test2 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { EvmHypSyntheticAdapter } from './EvmTokenAdapter.js';

describe('EvmHypSyntheticAdapter.quoteTransferRemoteGas', () => {
  const TOKEN_ADDRESS = '0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b';
  const RECIPIENT = '0x1111111111111111111111111111111111111111';
  const DESTINATION_DOMAIN = test2.domainId!;
  const AMOUNT = 100n;

  let adapter: EvmHypSyntheticAdapter;
  let sandbox: sinon.SinonSandbox;

  // Stubs the versioned quoteTransferRemote(uint32,bytes32,uint256) call to return
  // the provided [token, amount] tuples, mirroring TokenRouter.quoteTransferRemote:
  //   [0] gas payment, [1] transfer amount + internal fee, [2] external fee.
  function stubRawQuotes(quotes: Array<[string, bigint]>) {
    sandbox.stub(adapter, 'getContractPackageVersion').resolves('10.0.0');
    const quoteFn = sandbox.stub().resolves(
      quotes.map(([token, amount]) => ({
        0: token,
        1: BigNumber.from(amount),
      })),
    );
    // @ts-ignore inject a minimal contract stub for the unit test
    adapter.contract = {
      'quoteTransferRemote(uint32,bytes32,uint256)': quoteFn,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmHypSyntheticAdapter(test1.name, multiProvider, {
      token: TOKEN_ADDRESS,
    });
  });

  afterEach(() => sandbox.restore());

  it('does not count the bridged amount as a native fee for native routes', async () => {
    // Native route: token() == address(0), so every quote is denominated in address(0).
    // Regression guard: index 1 (amount + fee) must not be summed into the IGP quote.
    stubRawQuotes([
      [constants.AddressZero, 5n],
      [constants.AddressZero, AMOUNT],
      [constants.AddressZero, 0n],
    ]);

    const result = await adapter.quoteTransferRemoteGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: AMOUNT,
    });

    expect(result.igpQuote.amount).to.equal(5n);
    expect(result.tokenFeeQuote).to.equal(undefined);
  });

  it('sums native fees for native routes with internal and external fees', async () => {
    stubRawQuotes([
      [constants.AddressZero, 5n],
      [constants.AddressZero, AMOUNT + 7n],
      [constants.AddressZero, 3n],
    ]);

    const result = await adapter.quoteTransferRemoteGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: AMOUNT,
    });

    expect(result.igpQuote.amount).to.equal(15n);
    expect(result.tokenFeeQuote).to.equal(undefined);
  });

  it('returns only the native gas payment for ERC20 routes without fees', async () => {
    stubRawQuotes([
      [constants.AddressZero, 5n],
      [TOKEN_ADDRESS, AMOUNT],
      [TOKEN_ADDRESS, 0n],
    ]);

    const result = await adapter.quoteTransferRemoteGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: AMOUNT,
    });

    expect(result.igpQuote.amount).to.equal(5n);
    expect(result.tokenFeeQuote).to.equal(undefined);
  });

  it('collects ERC20 gas and fees into the tokenFeeQuote', async () => {
    stubRawQuotes([
      [TOKEN_ADDRESS, 5n],
      [TOKEN_ADDRESS, AMOUNT + 7n],
      [TOKEN_ADDRESS, 3n],
    ]);

    const result = await adapter.quoteTransferRemoteGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: AMOUNT,
    });

    expect(result.igpQuote.amount).to.equal(0n);
    expect(result.tokenFeeQuote?.addressOrDenom).to.equal(TOKEN_ADDRESS);
    expect(result.tokenFeeQuote?.amount).to.equal(15n);
  });
});
