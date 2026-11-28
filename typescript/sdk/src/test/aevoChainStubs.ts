import { BigNumber, constants, providers, utils } from 'ethers';
import sinon from 'sinon';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { AevoMintAuthority } from '../token/adapters/ITokenAdapter.js';

import { AEVO_SELECTORS, abiWord } from './aevoTokenFixture.js';

// A block at a height, as a provider reports its latest.
export function blockAt(number: number): providers.Block {
  return {
    number,
    hash: utils.hexZeroPad(utils.hexlify(number), 32),
    parentHash: utils.hexZeroPad(utils.hexlify(number - 1), 32),
    timestamp: number,
    nonce: '0x0000000000000000',
    difficulty: 0,
    _difficulty: BigNumber.from(0),
    gasLimit: BigNumber.from(0),
    gasUsed: BigNumber.from(0),
    miner: constants.AddressZero,
    extraData: '0x',
    transactions: [],
  };
}

export interface AevoChainCall {
  selector: string;
  // The block the call was made at, as the provider was asked for it.
  blockTag: unknown;
  // The height it was answered at.
  height: number;
}

/**
 * Stubs the eth_call of a provider as a chain that has moved on while a minter
 * is read, as it does when a block that sets the cap of a minter and authorizes
 * it lands, or when the nodes that answer are not at the same height.
 *
 * `stateAt` is what the token holds for the minter at each height. A call that
 * pins its block is answered at it. One that leaves its block to the node is
 * answered at the height `unpinnedHeights` gives for its place among the calls,
 * the last one for the places after. A call at a height `stateAt` does not hold,
 * or at a named block tag other than the latest, is not answered.
 */
export function stubAevoChainThatMoves({
  sandbox,
  provider,
  stateAt,
  unpinnedHeights,
}: {
  sandbox: sinon.SinonSandbox;
  provider: providers.Provider;
  stateAt: Record<number, AevoMintAuthority>;
  unpinnedHeights: number[];
}): { calls: AevoChainCall[] } {
  const calls: AevoChainCall[] = [];

  sandbox.stub(provider, 'call').callsFake(async (tx, blockTag) => {
    const data = await tx.data;
    assert(typeof data === 'string', 'Expected calldata');
    const unpinned =
      blockTag === undefined || blockTag === 'latest'
        ? unpinnedHeights[Math.min(calls.length, unpinnedHeights.length - 1)]
        : undefined;
    const height = typeof blockTag === 'number' ? blockTag : unpinned;
    assert(
      height !== undefined,
      `Unexpected block tag ${String(blockTag)} for a call`,
    );
    const state = stateAt[height];
    assert(state, `Unexpected call at height ${height}`);

    const selector = data.slice(0, 10);
    calls.push({ selector, blockTag, height });

    if (selector === AEVO_SELECTORS.authorities) {
      return ensure0x(abiWord(state.authorized ? 1 : 0));
    }
    if (selector === AEVO_SELECTORS.caps) {
      return ensure0x(abiWord(state.cap));
    }
    throw new Error(`Unexpected call ${data}`);
  });

  return { calls };
}
