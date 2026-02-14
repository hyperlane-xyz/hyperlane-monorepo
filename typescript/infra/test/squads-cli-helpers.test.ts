import { expect } from 'chai';
import yargs from 'yargs';

import { ChainName, getSquadsChains } from '@hyperlane-xyz/sdk';

import {
  resolveSquadsChains,
  withRequiredSquadsChain,
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

  it('throws for explicitly provided non-squads chain', () => {
    expect(() => resolveSquadsChains(['ethereum' as ChainName])).to.throw(
      'Squads configuration not found for chains: ethereum',
    );
  });

  it('reports unsupported chains once when duplicates are provided', () => {
    expect(() =>
      resolveSquadsChains([
        'ethereum' as ChainName,
        'ethereum' as ChainName,
        'arbitrum' as ChainName,
      ]),
    ).to.throw('Squads configuration not found for chains: ethereum, arbitrum');
  });

  it('returns a defensive copy for explicit chains', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = [firstChain, secondChain];
    const resolvedChains = resolveSquadsChains(selectedChains);

    resolvedChains.push(firstChain);

    expect(selectedChains).to.deep.equal([firstChain, secondChain]);
  });

  it('returns a defensive copy for default squads chains', () => {
    const resolvedChains = resolveSquadsChains(undefined);
    const firstChain = resolvedChains[0];

    resolvedChains.splice(0, 1);

    expect(resolveSquadsChains(undefined)).to.include(firstChain);
  });

  it('parses chain from c alias', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await withSquadsChain(yargs(['-c', chain])).parse();

    expect(parsedArgs.chain).to.equal(chain);
  });

  it('rejects non-squads chain via chain parser choices', async () => {
    let parserError: Error | undefined;
    try {
      await withSquadsChain(
        yargs(['--chain', 'ethereum']).exitProcess(false),
      ).parse();
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Invalid values');
  });

  it('requires chain when using required chain parser helper', async () => {
    let parserError: Error | undefined;
    try {
      await withRequiredSquadsChain(yargs([]).exitProcess(false)).parse();
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Missing required argument: chain');
  });

  it('deduplicates chains parsed from repeated args', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await withSquadsChains(
      yargs(['--chains', chain, '--chains', chain]),
    ).parse();

    expect(parsedArgs.chains).to.deep.equal([chain]);
  });

  it('deduplicates long-form chains while preserving first-seen order', async () => {
    const [firstChain, secondChain] = getSquadsChains();

    const parsedArgs = await withSquadsChains(
      yargs([
        '--chains',
        firstChain,
        '--chains',
        secondChain,
        '--chains',
        firstChain,
      ]),
    ).parse();

    expect(parsedArgs.chains).to.deep.equal([firstChain, secondChain]);
  });

  it('parses chains from c alias and deduplicates', async () => {
    const [firstChain, secondChain] = getSquadsChains();

    const parsedArgs = await withSquadsChains(
      yargs(['-c', firstChain, '-c', secondChain, '-c', firstChain]),
    ).parse();

    expect(parsedArgs.chains).to.deep.equal([firstChain, secondChain]);
  });

  it('rejects non-squads chain via chains parser choices', async () => {
    let parserError: Error | undefined;
    try {
      await withSquadsChains(
        yargs(['--chains', 'ethereum']).exitProcess(false),
      ).parse();
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Invalid values');
  });
});
