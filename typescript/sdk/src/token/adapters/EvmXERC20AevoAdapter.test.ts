import { expect } from 'chai';
import sinon from 'sinon';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { AEVO_SELECTORS, abiWord } from '../../test/aevoTokenFixture.js';
import { isMissingSelectorRevert } from '../../utils/contract.js';

import { EvmXERC20AevoAdapter } from './EvmTokenAdapter.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const MINTER = '0x4444444444444444444444444444444444444444';

const word = abiWord;

const AUTHORITIES = AEVO_SELECTORS.authorities;
const CAPS = AEVO_SELECTORS.caps;
const UPDATE_AUTHORITY = AEVO_SELECTORS.updateAuthority;
const SET_CAP = AEVO_SELECTORS.setCap;

describe('EvmXERC20AevoAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProtocolProvider;
  let adapter: EvmXERC20AevoAdapter;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmXERC20AevoAdapter(test1.name, multiProvider, {
      token: TOKEN,
    });
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

  it('reads empty return data as a missing getter, not as an unauthorized minter', async () => {
    sandbox.stub(adapter.getProvider(), 'call').resolves('0x');

    let thrown: unknown;
    try {
      await adapter.getMintAuthority(MINTER);
    } catch (error) {
      thrown = error;
    }

    expect(isMissingSelectorRevert(thrown)).to.equal(true);
  });

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
    it(`does not read ${c.name} as a minter's authority or cap`, async () => {
      sandbox.stub(adapter.getProvider(), 'call').resolves(c.data);

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

  it('propagates a failed read', async () => {
    const failure = new Error('Invalid response from provider');
    sandbox.stub(adapter.getProvider(), 'call').rejects(failure);

    let thrown: unknown;
    try {
      await adapter.getMintAuthority(MINTER);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(failure);
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
