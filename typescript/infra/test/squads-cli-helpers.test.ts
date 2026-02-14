import { expect } from 'chai';
import yargs, { type Argv } from 'yargs';

import { ChainName, getSquadsChains } from '@hyperlane-xyz/sdk';

import {
  getUnsupportedSquadsChainsErrorMessage,
  resolveSquadsChains,
  withRequiredSquadsChain,
  withSquadsChain,
  withSquadsChains,
} from '../scripts/squads/cli-helpers.js';

function parseArgs(args: Argv) {
  return args
    .exitProcess(false)
    .showHelpOnFail(false)
    .fail((message, error) => {
      if (error) throw error;
      throw new Error(message);
    })
    .parse();
}

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

  it('includes available squads chains in unsupported-chain error', () => {
    const availableChains = getSquadsChains().join(', ');

    expect(() => resolveSquadsChains(['ethereum' as ChainName])).to.throw(
      `Available Squads chains: ${availableChains}`,
    );
  });

  it('formats unsupported-chain error message with available chains', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['ethereum' as ChainName, 'arbitrum' as ChainName],
        ['solanamainnet' as ChainName],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum, arbitrum. Available Squads chains: solanamainnet',
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

    const parsedArgs = await parseArgs(withSquadsChain(yargs(['-c', chain])));

    expect(parsedArgs.chain).to.equal(chain);
  });

  it('rejects non-squads chain via chain parser choices', async () => {
    let parserError: Error | undefined;
    try {
      await parseArgs(withSquadsChain(yargs(['--chain', 'ethereum'])));
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Invalid values');
  });

  it('requires chain when using required chain parser helper', async () => {
    let parserError: Error | undefined;
    try {
      await parseArgs(withRequiredSquadsChain(yargs([])));
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Missing required argument: chain');
  });

  it('parses chain when using required chain parser helper', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await parseArgs(
      withRequiredSquadsChain(yargs(['--chain', chain])),
    );

    expect(parsedArgs.chain).to.equal(chain);
  });

  it('deduplicates chains parsed from repeated args', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await parseArgs(
      withSquadsChains(yargs(['--chains', chain, '--chains', chain])),
    );

    expect(parsedArgs.chains).to.deep.equal([chain]);
  });

  it('deduplicates long-form chains while preserving first-seen order', async () => {
    const [firstChain, secondChain] = getSquadsChains();

    const parsedArgs = await parseArgs(
      withSquadsChains(
        yargs([
          '--chains',
          firstChain,
          '--chains',
          secondChain,
          '--chains',
          firstChain,
        ]),
      ),
    );

    expect(parsedArgs.chains).to.deep.equal([firstChain, secondChain]);
  });

  it('parses chains from c alias and deduplicates', async () => {
    const [firstChain, secondChain] = getSquadsChains();

    const parsedArgs = await parseArgs(
      withSquadsChains(
        yargs(['-c', firstChain, '-c', secondChain, '-c', firstChain]),
      ),
    );

    expect(parsedArgs.chains).to.deep.equal([firstChain, secondChain]);
  });

  it('rejects non-squads chain via chains parser choices', async () => {
    let parserError: Error | undefined;
    try {
      await parseArgs(withSquadsChains(yargs(['--chains', 'ethereum'])));
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Invalid values');
  });
});
