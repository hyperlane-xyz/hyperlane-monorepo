import { expect } from 'chai';
import sinon from 'sinon';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { blockAt, stubAevoChainThatMoves } from '../../test/aevoChainStubs.js';
import { AEVO_SELECTORS, abiWord } from '../../test/aevoTokenFixture.js';
import { isMissingSelectorRevert } from '../../utils/contract.js';
import { AEVO_OUTSTANDING_SELECTOR } from '../xerc20-abi.js';

import { EvmXERC20AevoAdapter } from './EvmTokenAdapter.js';
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
