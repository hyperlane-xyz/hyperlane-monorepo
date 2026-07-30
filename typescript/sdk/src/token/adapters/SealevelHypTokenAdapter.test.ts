import { PublicKey } from '@solana/web3.js';
import { BinaryReader, BinaryWriter } from 'borsh';
import { expect } from 'chai';
import sinon from 'sinon';

import { Domain } from '@hyperlane-xyz/utils';

import {
  SealevelIgpAdapter,
  SealevelOverheadIgpAdapter,
} from '../../gas/adapters/SealevelIgpAdapter.js';
import {
  SealevelIgpData,
  SealevelInterchainGasPaymasterConfig,
  SealevelInterchainGasPaymasterType,
  SealevelOverheadIgpData,
} from '../../gas/adapters/serialization.js';
import { TestChainName, testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { SealevelHypSyntheticAdapter } from './SealevelTokenAdapter.js';
import { SealevelHyperlaneTokenData } from './serialization.js';

// Mints a genuine borsh-decoded u64 (bn.js `BN`) — the runtime type
// gas_overheads carries — so the boundary test sees what a live account decode
// produces, not a hand-built bigint.
function borshU64(value: number): ReturnType<BinaryReader['readU64']> {
  const writer = new BinaryWriter();
  writer.writeU64(value);
  return new BinaryReader(Buffer.from(writer.toArray())).readU64();
}

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

describe('SealevelHypTokenAdapter innerIgpFeeState', () => {
  let multiProvider: MultiProtocolProvider;
  let adapter: TestAdapter;
  let remoteDomain: Domain;

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    remoteDomain = multiProvider.getDomainId(TestChainName.test2);
    adapter = new TestAdapter(TestChainName.test1, multiProvider, {
      warpRouter: PLACEHOLDER,
      token: PLACEHOLDER,
      mailbox: PLACEHOLDER,
    });
  });

  afterEach(() => sinon.restore());

  it('normalizes borsh-decoded BN gas_overheads to bigint for an OverheadIgp route', async () => {
    // borsh@0.7 decodes gas_overheads u64 values as bn.js BN; the boundary must
    // convert them so consumers can do bigint arithmetic without a BN mix
    // (which throws). Feed a genuine BN and assert bigint comes back out.
    adapter.tokenDataStub = new SealevelHyperlaneTokenData({
      bump: 1,
      mailbox: new Uint8Array(32),
      mailbox_process_authority: new Uint8Array(32),
      dispatch_authority_bump: 1,
      decimals: 9,
      remote_decimals: 9,
      interchain_gas_paymaster: new SealevelInterchainGasPaymasterConfig({
        program_id: new Uint8Array(32).fill(1),
        type: SealevelInterchainGasPaymasterType.OverheadIgp,
        igp_account: new Uint8Array(32).fill(2),
      }),
    });
    sinon.stub(SealevelOverheadIgpAdapter.prototype, 'getAccountInfo').resolves(
      new SealevelOverheadIgpData({
        bump: 0,
        salt: new Uint8Array(32),
        inner: new Uint8Array(32).fill(3),
        gas_overheads: new Map([[remoteDomain, borshU64(200)]]),
      }),
    );
    sinon.stub(SealevelIgpAdapter.prototype, 'getAccountInfo').resolves(
      new SealevelIgpData({
        bump_seed: 0,
        salt: new Uint8Array(32),
        beneficiary: new Uint8Array(32),
        gas_oracles: new Map(),
      }),
    );

    const state = await adapter.innerIgpFeeState.get();
    const overhead = state?.gasOverheads?.get(remoteDomain);

    expect(typeof overhead).to.equal('bigint');
    expect(overhead).to.equal(200n);
  });
});
