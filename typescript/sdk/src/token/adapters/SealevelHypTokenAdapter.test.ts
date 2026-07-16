import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import { Domain } from '@hyperlane-xyz/utils';

import { TestChainName, testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { SealevelHypSyntheticAdapter } from './SealevelTokenAdapter.js';
import { SealevelHyperlaneTokenData } from './serialization.js';

const PLACEHOLDER = '11111111111111111111111111111111';
const SENDER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const RECIPIENT = new PublicKey(Buffer.alloc(32, 5)).toBase58();
const DEST_GAS = 50_000n;

// Stubs the RPC account fetch and records whether the IGP quote path was
// entered. `getIgpAdapter` returning undefined keeps the quote at 0 without a
// live IGP program, so `igpAdapterCalls` isolates the same-domain gate.
class TestAdapter extends SealevelHypSyntheticAdapter {
  tokenDataStub!: SealevelHyperlaneTokenData;
  igpAdapterCalls = 0;

  override getTokenAccountData(): Promise<SealevelHyperlaneTokenData> {
    return Promise.resolve(this.tokenDataStub);
  }

  override getIgpAdapter(): undefined {
    this.igpAdapterCalls += 1;
    return undefined;
  }
}

function buildTokenData(gasDomain: Domain): SealevelHyperlaneTokenData {
  return new SealevelHyperlaneTokenData({
    bump: 1,
    mailbox: new Uint8Array(32),
    mailbox_process_authority: new Uint8Array(32),
    dispatch_authority_bump: 1,
    decimals: 9,
    remote_decimals: 9,
    destination_gas: new Map<Domain, bigint>([[gasDomain, DEST_GAS]]),
  });
}

describe('SealevelHypTokenAdapter IGP quoting', () => {
  let multiProvider: MultiProtocolProvider;
  let adapter: TestAdapter;
  let localDomain: Domain;
  let remoteDomain: Domain;

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    localDomain = multiProvider.getDomainId(TestChainName.test1);
    remoteDomain = multiProvider.getDomainId(TestChainName.test2);
    adapter = new TestAdapter(TestChainName.test1, multiProvider, {
      warpRouter: PLACEHOLDER,
      token: PLACEHOLDER,
      mailbox: PLACEHOLDER,
    });
  });

  it('skips the IGP quote for a same-domain (local) transfer', async () => {
    // destination_gas is configured for the local domain; the same-domain gate
    // must still short-circuit before consulting the IGP.
    adapter.tokenDataStub = buildTokenData(localDomain);

    const quote = await adapter.quoteTransferRemoteGas({
      destination: localDomain,
      sender: SENDER,
      recipient: RECIPIENT,
      amount: 1n,
    });

    expect(quote.igpQuote.amount).to.equal(0n);
    expect(adapter.igpAdapterCalls).to.equal(0);
  });

  it('quotes the IGP for a remote transfer with configured destination gas', async () => {
    adapter.tokenDataStub = buildTokenData(remoteDomain);

    await adapter.quoteTransferRemoteGas({
      destination: remoteDomain,
      sender: SENDER,
      recipient: RECIPIENT,
      amount: 1n,
    });

    expect(adapter.igpAdapterCalls).to.equal(1);
  });
});
