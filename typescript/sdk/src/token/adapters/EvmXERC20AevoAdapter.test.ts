import { expect } from 'chai';
import sinon from 'sinon';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { UIN256_MAX_VALUE } from '../../consts/numbers.js';
import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  AevoTokenState,
  blockAt,
  stubAevoChainThatMoves,
} from '../../test/aevoChainStubs.js';
import { AEVO_SELECTORS, abiWord } from '../../test/aevoTokenFixture.js';
import { isMissingSelectorRevert } from '../../utils/contract.js';
import { AEVO_OUTSTANDING_SELECTOR } from '../xerc20-abi.js';

import {
  EvmHypAevoXERC20Adapter,
  EvmXERC20AevoAdapter,
} from './EvmTokenAdapter.js';
import { AevoMintAuthority } from './ITokenAdapter.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const MINTER = '0x4444444444444444444444444444444444444444';
const HEAD = 100;

const word = abiWord;

const AUTHORITIES = AEVO_SELECTORS.authorities;
const CAPS = AEVO_SELECTORS.caps;
const UPDATE_AUTHORITY = AEVO_SELECTORS.updateAuthority;
const SET_CAP = AEVO_SELECTORS.setCap;
const OUTSTANDING = AEVO_OUTSTANDING_SELECTOR;

describe('EvmXERC20AevoAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProtocolProvider;
  let adapter: EvmXERC20AevoAdapter;
  let getBlock: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmXERC20AevoAdapter(test1.name, multiProvider, {
      token: TOKEN,
    });
    getBlock = sandbox
      .stub(adapter.getProvider(), 'getBlock')
      .resolves(blockAt(HEAD));
  });

  afterEach(() => sandbox.restore());

  interface ReadCase {
    name: string;
    authorityWord: string;
    capWord: string;
    expected: { authorized: boolean; cap: bigint };
  }

  const readCases: ReadCase[] = [
    {
      name: 'reads an authorized minter and its cap',
      authorityWord: word(1),
      capWord: word(5_000_000n),
      expected: { authorized: true, cap: 5_000_000n },
    },
    {
      name: 'reads an unauthorized minter without a cap',
      authorityWord: word(0),
      capWord: word(0),
      expected: { authorized: false, cap: 0n },
    },
    {
      // Revoking an authority leaves its cap behind.
      name: 'reads a revoked minter that keeps its cap',
      authorityWord: word(0),
      capWord: word(1000),
      expected: { authorized: false, cap: 1000n },
    },
    {
      name: 'reads a cap beyond 2^64',
      authorityWord: word(1),
      capWord: word(2n ** 100n),
      expected: { authorized: true, cap: 2n ** 100n },
    },
  ];

  for (const c of readCases) {
    it(c.name, async () => {
      const calls: Array<{ to?: string; data?: string }> = [];
      sandbox.stub(adapter.getProvider(), 'call').callsFake(async (tx) => {
        const data = await tx.data;
        assert(typeof data === 'string', 'Expected calldata');
        calls.push({ to: await tx.to, data });
        if (data.startsWith(AUTHORITIES)) return ensure0x(c.authorityWord);
        if (data.startsWith(CAPS)) return ensure0x(c.capWord);
        throw new Error(`Unexpected call ${data}`);
      });

      const result = await adapter.getMintAuthority(MINTER);

      expect(result).to.deep.equal(c.expected);
      expect(calls.map((call) => call.to)).to.deep.equal([TOKEN, TOKEN]);
      expect(calls.map((call) => call.data)).to.have.members([
        `${AUTHORITIES}${word(MINTER)}`,
        `${CAPS}${word(MINTER)}`,
      ]);
    });
  }

  interface Getter {
    name: string;
    reads: string;
    selector: string;
  }

  const getters: Getter[] = [
    {
      name: 'authorities',
      reads: "a minter's authority",
      selector: AUTHORITIES,
    },
    { name: 'caps', reads: "a minter's cap", selector: CAPS },
  ];

  // The token is read through both getters, so a getter that answers valid data
  // for the one that does not fail leaves the failure of the other as the only
  // thing that can be thrown, and a read that took it for an answer shows.
  function stubFailingGetter(getter: Getter, answer: () => Promise<string>) {
    sandbox.stub(adapter.getProvider(), 'call').callsFake(async (tx) => {
      const data = await tx.data;
      assert(typeof data === 'string', 'Expected calldata');
      if (data.startsWith(getter.selector)) return answer();
      if (data.startsWith(AUTHORITIES)) return ensure0x(word(1));
      if (data.startsWith(CAPS)) return ensure0x(word(5_000_000n));
      throw new Error(`Unexpected call ${data}`);
    });
  }

  for (const getter of getters) {
    it(`reads empty return data from ${getter.name} as a missing getter, not as ${getter.reads}`, async () => {
      stubFailingGetter(getter, async () => '0x');

      let thrown: unknown;
      try {
        await adapter.getMintAuthority(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(isMissingSelectorRevert(thrown)).to.equal(true);
    });
  }

  interface RevertCase {
    name: string;
    // Revert data a node answers an eth_call with, which ethers v5 hands back
    // as the call's result.
    data: string;
  }

  const revertCases: RevertCase[] = [
    { name: 'a custom error', data: '0x82b42900' },
    {
      // Word sized once its selector is counted out, which a uint256 decoder
      // would take for a cap.
      name: 'a custom error with one word of arguments',
      data: `0x82b42900${word(1000)}`,
    },
    {
      name: 'an Error(string)',
      data: `0x08c379a0${word(32)}${word(4)}${'74657374'.padEnd(64, '0')}`,
    },
  ];

  for (const c of revertCases) {
    for (const getter of getters) {
      it(`does not read ${c.name} from ${getter.name} as ${getter.reads}`, async () => {
        stubFailingGetter(getter, async () => c.data);

        let thrown: unknown;
        try {
          await adapter.getMintAuthority(MINTER);
        } catch (error) {
          thrown = error;
        }

        // The revert is surfaced as the call exception it is, with its data.
        expect(thrown).to.be.instanceOf(Error);
        expect(thrown).to.have.property('code', 'CALL_EXCEPTION');
        expect(thrown).to.have.property('data', c.data);
        expect(isMissingSelectorRevert(thrown)).to.equal(false);
      });
    }
  }

  for (const getter of getters) {
    it(`propagates a failed read of ${getter.name}`, async () => {
      const failure = new Error('Invalid response from provider');
      stubFailingGetter(getter, () => Promise.reject(failure));

      let thrown: unknown;
      try {
        await adapter.getMintAuthority(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.equal(failure);
    });
  }

  // Two reads of the latest state may straddle the block that sets the cap of
  // a minter and authorizes it, and pair the old cap with the new authority, or
  // the other way round. The token is read at one block instead.
  describe('the block it reads at', () => {
    interface MovingCase {
      name: string;
      // What the token holds at the head, and at the block after it.
      atHead: AevoMintAuthority;
      afterHead: AevoMintAuthority;
      // The height each unpinned call would be answered at: the first is the
      // authority, the second the cap.
      unpinnedHeights: number[];
      // What an unpinned read would have reported, which is no state of the
      // token at any height.
      torn: AevoMintAuthority;
    }

    const movingCases: MovingCase[] = [
      {
        // The cap is read before the block that sets it, the authority after
        // the block that grants it: a minter without a bound that never was.
        name: 'a cap set before a minter is authorized',
        atHead: { authorized: false, cap: 0n },
        afterHead: { authorized: true, cap: 5_000_000n },
        unpinnedHeights: [HEAD + 1, HEAD],
        torn: { authorized: true, cap: 0n },
      },
      {
        // The authority is read before the block that revokes it, the cap after
        // the block that sets it: a minter bounded by a cap that never was.
        name: 'a minter revoked along with its cap changed',
        atHead: { authorized: true, cap: 5_000_000n },
        afterHead: { authorized: false, cap: 7_000_000n },
        unpinnedHeights: [HEAD, HEAD + 1],
        torn: { authorized: true, cap: 7_000_000n },
      },
    ];

    for (const c of movingCases) {
      const stub = () =>
        stubAevoChainThatMoves({
          sandbox,
          provider: adapter.getProvider(),
          stateAt: { [HEAD]: c.atHead, [HEAD + 1]: c.afterHead },
          unpinnedHeights: c.unpinnedHeights,
        });

      it(`reads the authority and the cap at the head it found, for ${c.name}`, async () => {
        const chain = stub();

        const result = await adapter.getMintAuthority(MINTER);

        expect(result).to.deep.equal(c.atHead);
        expect(result).to.not.deep.equal(c.torn);
        expect(getBlock.calledOnceWithExactly('latest')).to.equal(true);
        expect(chain.calls.map((call) => call.selector)).to.have.members([
          AUTHORITIES,
          CAPS,
        ]);
        expect(chain.calls.map((call) => call.blockTag)).to.deep.equal([
          HEAD,
          HEAD,
        ]);
      });

      it(`reads the authority and the cap at the block it is asked for, without looking for the head, for ${c.name}`, async () => {
        const chain = stub();

        const result = await adapter.getMintAuthority(MINTER, HEAD + 1);

        expect(result).to.deep.equal(c.afterHead);
        expect(getBlock.notCalled).to.equal(true);
        expect(chain.calls.map((call) => call.blockTag)).to.deep.equal([
          HEAD + 1,
          HEAD + 1,
        ]);
      });
    }

    it('fails when a read at the block fails, without reading the latest state instead', async () => {
      const failure = new Error('header not found');
      const call = sandbox.stub(adapter.getProvider(), 'call').rejects(failure);

      let thrown: unknown;
      try {
        await adapter.getMintAuthority(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.equal(failure);
      expect(call.args.map(([, blockTag]) => blockTag)).to.deep.equal([
        HEAD,
        HEAD,
      ]);
    });

    it('fails when the head cannot be read, without reading the latest state instead', async () => {
      const failure = new Error('Invalid response from provider');
      getBlock.rejects(failure);
      const call = sandbox.stub(adapter.getProvider(), 'call');

      let thrown: unknown;
      try {
        await adapter.getMintAuthority(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.equal(failure);
      expect(call.notCalled).to.equal(true);
    });

    it('fails when the provider reports no latest block', async () => {
      getBlock.resolves(null);
      const call = sandbox
        .stub(adapter.getProvider(), 'call')
        .resolves(ensure0x(word(0)));

      let thrown: unknown;
      try {
        await adapter.getMintAuthority(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(Error);
      expect(thrown).to.have.property(
        'message',
        `Missing the latest block of ${test1.name}`,
      );
      expect(call.notCalled).to.equal(true);
    });
  });

  describe('getOutstanding', () => {
    it('reads what a minter has minted and not burned, at the block asked for', async () => {
      const call = sandbox
        .stub(adapter.getProvider(), 'call')
        .resolves(ensure0x(word(105n)));

      expect(await adapter.getOutstanding(MINTER, 1234)).to.equal(105n);

      sinon.assert.calledOnceWithExactly(
        call,
        { to: TOKEN, data: `${OUTSTANDING}${word(MINTER)}` },
        1234,
      );
    });

    it('reads a count beyond 2^64', async () => {
      sandbox
        .stub(adapter.getProvider(), 'call')
        .resolves(ensure0x(word(2n ** 100n)));

      expect(await adapter.getOutstanding(MINTER)).to.equal(2n ** 100n);
    });

    for (const c of revertCases) {
      it(`does not read ${c.name} as a count`, async () => {
        sandbox.stub(adapter.getProvider(), 'call').resolves(c.data);

        let thrown: unknown;
        try {
          await adapter.getOutstanding(MINTER);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).to.have.property('code', 'CALL_EXCEPTION');
        expect(thrown).to.have.property('data', c.data);
      });
    }

    it('reads empty return data as a missing getter, not as a count of zero', async () => {
      sandbox.stub(adapter.getProvider(), 'call').resolves('0x');

      let thrown: unknown;
      try {
        await adapter.getOutstanding(MINTER);
      } catch (error) {
        thrown = error;
      }

      expect(isMissingSelectorRevert(thrown)).to.equal(true);
    });
  });

  it('populates updateAuthority against the token', async () => {
    expect(await adapter.populateUpdateAuthorityTx(MINTER, true)).to.deep.equal(
      {
        to: TOKEN,
        data: `${UPDATE_AUTHORITY}${word(MINTER)}${word(1)}`,
      },
    );
    expect(
      await adapter.populateUpdateAuthorityTx(MINTER, false),
    ).to.deep.equal({
      to: TOKEN,
      data: `${UPDATE_AUTHORITY}${word(MINTER)}${word(0)}`,
    });
  });

  it('populates setCap against the token', async () => {
    expect(await adapter.populateSetCapTx(MINTER, 5_000_000n)).to.deep.equal({
      to: TOKEN,
      data: `${SET_CAP}${word(MINTER)}${word(5_000_000n)}`,
    });
  });
});

// The limits of a router over an Aevo token are what the token holds for it:
// its authority and cap, and what it has minted and not burned.
describe('EvmHypAevoXERC20Adapter', () => {
  const ROUTER = '0x5555555555555555555555555555555555555555';

  let sandbox: sinon.SinonSandbox;
  let adapter: EvmHypAevoXERC20Adapter;
  let getBlock: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    adapter = new EvmHypAevoXERC20Adapter(
      test1.name,
      MultiProtocolProvider.createTestMultiProtocolProvider(),
      { token: ROUTER },
    );
    sandbox.stub(adapter, 'getWrappedTokenAddress').resolves(TOKEN);
    getBlock = sandbox
      .stub(adapter.getProvider(), 'getBlock')
      .resolves(blockAt(HEAD));
  });

  afterEach(() => sandbox.restore());

  type Limits = Awaited<ReturnType<EvmHypAevoXERC20Adapter['getLimits']>>;

  interface LimitsCase {
    name: string;
    state: AevoTokenState;
    expected: Limits;
  }

  const limitsCases: LimitsCase[] = [
    {
      name: 'has none for a router that is not authorized, whatever it keeps',
      state: { authorized: false, cap: 105n, outstanding: 30n },
      expected: { mint: 0n, mintMax: 0n, burn: 0n, burnMax: 0n },
    },
    {
      name: 'has no cap to mint under, and nothing to burn, without a cap and without having minted',
      state: { authorized: true, cap: 0n, outstanding: 0n },
      expected: {
        mint: UIN256_MAX_VALUE,
        mintMax: UIN256_MAX_VALUE,
        burn: 0n,
        burnMax: UIN256_MAX_VALUE,
      },
    },
    {
      name: 'can burn what it has minted without a cap',
      state: { authorized: true, cap: 0n, outstanding: 30n },
      expected: {
        mint: UIN256_MAX_VALUE,
        mintMax: UIN256_MAX_VALUE,
        burn: 30n,
        burnMax: UIN256_MAX_VALUE,
      },
    },
    {
      name: 'can mint what is left of its cap, and burn what it has minted',
      state: { authorized: true, cap: 105n, outstanding: 30n },
      expected: { mint: 75n, mintMax: 105n, burn: 30n, burnMax: 105n },
    },
    {
      name: 'can mint nothing once it has minted the cap, and burn up to the cap',
      state: { authorized: true, cap: 105n, outstanding: 105n },
      expected: { mint: 0n, mintMax: 105n, burn: 105n, burnMax: 105n },
    },
    {
      // A burn is bound by what has been minted and not by the cap, which a
      // router that was lowered below it can still burn that much of.
      name: 'can mint nothing once its cap is lowered below what it has minted, and burn all it has minted',
      state: { authorized: true, cap: 20n, outstanding: 30n },
      expected: { mint: 0n, mintMax: 20n, burn: 30n, burnMax: 30n },
    },
  ];

  for (const c of limitsCases) {
    it(`${c.name}, through each getter and through getLimits`, async () => {
      stubAevoChainThatMoves({
        sandbox,
        provider: adapter.getProvider(),
        stateAt: { [HEAD]: c.state },
        unpinnedHeights: [HEAD],
      });

      const limits = await adapter.getLimits();
      expect(limits).to.deep.equal(c.expected);
      expect(limits.burn <= limits.burnMax).to.equal(true);
      expect(await adapter.getMintLimit()).to.equal(c.expected.mint);
      expect(await adapter.getMintMaxLimit()).to.equal(c.expected.mintMax);
      expect(await adapter.getBurnLimit()).to.equal(c.expected.burn);
      expect(await adapter.getBurnMaxLimit()).to.equal(c.expected.burnMax);
    });
  }

  // A block that raises the cap of the router and what it has minted lands
  // while it is read. Its cap before the block with what it has minted after
  // it leaves nothing to mint, which neither block had.
  it('reads the authority, the cap and what is outstanding at one block, as the chain moves on', async () => {
    const chain = stubAevoChainThatMoves({
      sandbox,
      provider: adapter.getProvider(),
      stateAt: {
        [HEAD]: { authorized: true, cap: 100n, outstanding: 10n },
        [HEAD + 1]: { authorized: true, cap: 200n, outstanding: 190n },
      },
      unpinnedHeights: [HEAD + 1],
    });

    expect(await adapter.getLimits()).to.deep.equal({
      mint: 90n,
      mintMax: 100n,
      burn: 10n,
      burnMax: 100n,
    });

    expect(getBlock.calledOnceWithExactly('latest')).to.equal(true);
    expect(chain.calls.map(({ selector }) => selector)).to.have.members([
      AUTHORITIES,
      CAPS,
      OUTSTANDING,
    ]);
    expect(chain.calls.map(({ blockTag }) => blockTag)).to.deep.equal([
      HEAD,
      HEAD,
      HEAD,
    ]);
    for (const { data } of chain.calls) {
      expect(data.endsWith(word(ROUTER))).to.equal(true);
    }
  });

  for (const getter of [
    'getMintLimit',
    'getMintMaxLimit',
    'getBurnLimit',
    'getBurnMaxLimit',
  ] as const) {
    it(`reads at the block it found when it is asked for ${getter}`, async () => {
      const chain = stubAevoChainThatMoves({
        sandbox,
        provider: adapter.getProvider(),
        stateAt: {
          [HEAD]: { authorized: true, cap: 100n, outstanding: 10n },
          [HEAD + 1]: { authorized: true, cap: 200n, outstanding: 190n },
        },
        unpinnedHeights: [HEAD + 1],
      });

      await adapter[getter]();

      expect(getBlock.calledOnceWithExactly('latest')).to.equal(true);
      expect(chain.calls.map(({ height }) => height)).to.satisfy(
        (heights: number[]) => heights.every((height) => height === HEAD),
      );
    });
  }

  interface ReadsCase {
    name: string;
    state: AevoTokenState;
    // Whether each way of asking reads what is outstanding, which is only
    // where the answer is not decided by the authority and the cap: the burn
    // maximum of a router with a cap is its cap, or what is outstanding beyond
    // it.
    reads: Record<
      | 'getLimits'
      | 'getMintLimit'
      | 'getMintMaxLimit'
      | 'getBurnLimit'
      | 'getBurnMaxLimit',
      boolean
    >;
  }

  const readsCases: ReadsCase[] = [
    {
      name: 'a router that is not authorized',
      state: { authorized: false, cap: 105n, outstanding: 30n },
      reads: {
        getLimits: false,
        getMintLimit: false,
        getMintMaxLimit: false,
        getBurnLimit: false,
        getBurnMaxLimit: false,
      },
    },
    {
      name: 'a router without a cap',
      state: { authorized: true, cap: 0n, outstanding: 30n },
      reads: {
        getLimits: true,
        getMintLimit: false,
        getMintMaxLimit: false,
        getBurnLimit: true,
        getBurnMaxLimit: false,
      },
    },
    {
      name: 'a router with a cap',
      state: { authorized: true, cap: 105n, outstanding: 30n },
      reads: {
        getLimits: true,
        getMintLimit: true,
        getMintMaxLimit: false,
        getBurnLimit: true,
        getBurnMaxLimit: true,
      },
    },
  ];

  // A read of what is outstanding that fails fails only what needs it: the mint
  // maximum is the authority and the cap.
  for (const c of readsCases) {
    for (const [getter, needsOutstanding] of Object.entries(c.reads)) {
      assert(
        getter === 'getLimits' ||
          getter === 'getMintLimit' ||
          getter === 'getMintMaxLimit' ||
          getter === 'getBurnLimit' ||
          getter === 'getBurnMaxLimit',
        `Unexpected getter ${getter}`,
      );

      it(`${
        needsOutstanding ? 'fails' : 'does not fail'
      } in ${getter} when what is outstanding cannot be read, for ${c.name}`, async () => {
        const chain = stubAevoChainThatMoves({
          sandbox,
          provider: adapter.getProvider(),
          stateAt: { [HEAD]: c.state },
          unpinnedHeights: [HEAD],
          failing: [OUTSTANDING],
        });

        let thrown: unknown;
        try {
          await adapter[getter]();
        } catch (error) {
          thrown = error;
        }

        const read = chain.calls.some(
          ({ selector }) => selector === OUTSTANDING,
        );
        expect(read).to.equal(needsOutstanding);
        if (needsOutstanding) {
          expect(thrown).to.have.property(
            'message',
            `injected ${OUTSTANDING} failure`,
          );
        } else {
          expect(thrown).to.equal(undefined);
        }
      });
    }
  }
});
