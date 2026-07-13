import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import {
  Address,
  Domain,
  addressToBytes,
  padBytesToLength,
} from '@hyperlane-xyz/utils';

import { TestChainName, testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import type { InterchainGasQuote, Quote } from './ITokenAdapter.js';
import { SealevelHypCrossCollateralAdapter } from './SealevelCrossCollateralAdapter.js';
import {
  SealevelHyperlaneTokenData,
  SealevelTokenFeeConfig,
} from './serialization.js';

const PLACEHOLDER = '11111111111111111111111111111111';
const SENDER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const RECIPIENT = new PublicKey(Buffer.alloc(32, 5)).toBase58();
const WARP_FEE_AMOUNT = 777n;
// Router passed explicitly to the "To" quote path.
const PASSED_ROUTER = new PublicKey(Buffer.alloc(32, 9)).toBase58();
// Router registered in the on-chain remote_routers map for the local domain,
// resolved by the non-"To" quote path.
const REGISTERED_ROUTER = new Uint8Array(Buffer.alloc(32, 7));

// Stub the two provider-touching dependencies so the local-transfer quote
// orchestration can be exercised without a validator: `getTokenAccountData`
// (RPC account fetch) and `quoteWarpFee` (fee-program simulation).
class TestCcAdapter extends SealevelHypCrossCollateralAdapter {
  tokenDataStub!: SealevelHyperlaneTokenData;
  warpFeeCalls: Array<{ destination: Domain; targetRouter: Uint8Array }> = [];

  override getTokenAccountData(): Promise<SealevelHyperlaneTokenData> {
    return Promise.resolve(this.tokenDataStub);
  }

  override quoteWarpFee(args: {
    feeConfig: SealevelTokenFeeConfig;
    payer: PublicKey;
    destination: Domain;
    recipient: Address;
    amount: bigint;
    targetRouter: Uint8Array;
  }): Promise<Quote> {
    this.warpFeeCalls.push({
      destination: args.destination,
      targetRouter: args.targetRouter,
    });
    return Promise.resolve({ amount: WARP_FEE_AMOUNT, addressOrDenom: 'FEE' });
  }
}

function buildTokenData({
  withFee,
  localDomain,
}: {
  withFee: boolean;
  localDomain: Domain;
}): SealevelHyperlaneTokenData {
  const data = new SealevelHyperlaneTokenData({
    bump: 1,
    mailbox: new Uint8Array(32),
    mailbox_process_authority: new Uint8Array(32),
    dispatch_authority_bump: 1,
    decimals: 9,
    remote_decimals: 9,
    remote_routers: new Map<number, Uint8Array>([
      [localDomain, REGISTERED_ROUTER],
    ]),
  });
  if (withFee) {
    data.fee_config = {
      feeProgram: new PublicKey(PLACEHOLDER),
      feeAccount: new PublicKey(PLACEHOLDER),
    };
  }
  return data;
}

// A local-transfer quote case. `withFee` discriminates the expectation shape:
// a fee-configured route must surface `tokenFeeQuote` quoted against
// `expectedTargetRouter`; an unconfigured route must not.
type LocalQuoteCase = {
  name: string;
  invoke: (
    adapter: TestCcAdapter,
    localDomain: Domain,
  ) => Promise<InterchainGasQuote>;
} & ({ withFee: true; expectedTargetRouter: Uint8Array } | { withFee: false });

const LOCAL_QUOTE_CASES: LocalQuoteCase[] = [
  {
    name: 'quoteTransferRemoteToGas quotes the warp fee against the passed router',
    withFee: true,
    expectedTargetRouter: padBytesToLength(addressToBytes(PASSED_ROUTER), 32),
    invoke: (adapter, localDomain) =>
      adapter.quoteTransferRemoteToGas({
        destination: localDomain,
        recipient: RECIPIENT,
        amount: 1000n,
        targetRouter: PASSED_ROUTER,
        sender: SENDER,
      }),
  },
  {
    name: 'quoteTransferRemoteToGas returns a zero quote with no tokenFeeQuote when fee_config is absent',
    withFee: false,
    invoke: (adapter, localDomain) =>
      adapter.quoteTransferRemoteToGas({
        destination: localDomain,
        recipient: RECIPIENT,
        amount: 1000n,
        targetRouter: PASSED_ROUTER,
        sender: SENDER,
      }),
  },
  {
    name: 'quoteTransferRemoteGas quotes the warp fee against the registered router',
    withFee: true,
    expectedTargetRouter: REGISTERED_ROUTER,
    invoke: (adapter, localDomain) =>
      adapter.quoteTransferRemoteGas({
        destination: localDomain,
        sender: SENDER,
        recipient: RECIPIENT,
        amount: 1000n,
      }),
  },
  {
    name: 'quoteTransferRemoteGas returns a zero quote with no tokenFeeQuote when fee_config is absent',
    withFee: false,
    invoke: (adapter, localDomain) =>
      adapter.quoteTransferRemoteGas({
        destination: localDomain,
        sender: SENDER,
        recipient: RECIPIENT,
        amount: 1000n,
      }),
  },
];

describe('SealevelHypCrossCollateralAdapter', () => {
  let multiProvider: MultiProtocolProvider;
  let adapter: TestCcAdapter;
  let localDomain: Domain;

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    localDomain = multiProvider.getDomainId(TestChainName.test1);
    adapter = new TestCcAdapter(TestChainName.test1, multiProvider, {
      warpRouter: PLACEHOLDER,
      token: PLACEHOLDER,
      mailbox: PLACEHOLDER,
    });
  });

  describe('local-transfer quoting', () => {
    for (const testCase of LOCAL_QUOTE_CASES) {
      it(testCase.name, async () => {
        adapter.tokenDataStub = buildTokenData({
          withFee: testCase.withFee,
          localDomain,
        });

        const quote = await testCase.invoke(adapter, localDomain);

        // Local transfers never make an IGP payment.
        expect(quote.igpQuote.amount).to.equal(0n);
        if (testCase.withFee) {
          expect(quote.tokenFeeQuote?.amount).to.equal(WARP_FEE_AMOUNT);
          expect(adapter.warpFeeCalls).to.have.length(1);
          expect(adapter.warpFeeCalls[0].destination).to.equal(localDomain);
          // The fee must be quoted against the destination router.
          expect(
            Buffer.from(adapter.warpFeeCalls[0].targetRouter),
          ).to.deep.equal(Buffer.from(testCase.expectedTargetRouter));
        } else {
          expect(quote.tokenFeeQuote).to.equal(undefined);
          expect(adapter.warpFeeCalls).to.have.length(0);
        }
      });
    }
  });
});
