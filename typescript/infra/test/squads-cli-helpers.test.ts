import { expect } from 'chai';
import yargs from 'yargs';

import { getSquadsChains } from '@hyperlane-xyz/sdk';

import {
  resolveSquadsChains,
  withSquadsChain,
  withSquadsChains,
} from '../scripts/squads/cli-helpers.js';

describe('squads cli helpers', () => {
  it('resolves to configured squads chains when undefined', () => {
    expect(resolveSquadsChains(undefined)).to.deep.equal(getSquadsChains());
  });

  it('resolves to configured squads chains when empty list', () => {
    expect(resolveSquadsChains([])).to.deep.equal(getSquadsChains());
  });

  it('resolves to provided chains when explicitly set', () => {
    const squadsChains = getSquadsChains();
    const selectedChains = [squadsChains[0]];

    expect(resolveSquadsChains(selectedChains)).to.deep.equal(selectedChains);
  });

  it('deduplicates explicitly provided chains while preserving order', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = [firstChain, secondChain, firstChain];

    expect(resolveSquadsChains(selectedChains)).to.deep.equal([
      firstChain,
      secondChain,
    ]);
  });

  it('parses chain from c alias', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await withSquadsChain(yargs(['-c', chain])).parse();

    expect(parsedArgs.chain).to.equal(chain);
  });

  it('deduplicates chains parsed from repeated args', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await withSquadsChains(
      yargs(['--chains', chain, '--chains', chain]),
    ).parse();

    expect(parsedArgs.chains).to.deep.equal([chain]);
  });

  it('parses chains from c alias and deduplicates', async () => {
    const [firstChain, secondChain] = getSquadsChains();

    const parsedArgs = await withSquadsChains(
      yargs(['-c', firstChain, '-c', secondChain, '-c', firstChain]),
    ).parse();

    expect(parsedArgs.chains).to.deep.equal([firstChain, secondChain]);
  });
});
