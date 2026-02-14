import { expect } from 'chai';
import yargs, { type Argv } from 'yargs';

import { getSquadsChains } from '@hyperlane-xyz/sdk';

import {
  getUnsupportedSquadsChainsErrorMessage,
  resolveSquadsChains,
  resolveSquadsChainsFromArgv,
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

  it('resolves argv chains from undefined input to configured squads chains', () => {
    expect(resolveSquadsChainsFromArgv(undefined)).to.deep.equal(
      getSquadsChains(),
    );
  });

  it('throws for non-array argv chains input when provided', () => {
    expect(() => resolveSquadsChainsFromArgv('solanamainnet')).to.throw(
      'Expected --chains to resolve to an array, but received string',
    );
  });

  it('labels numeric argv chains input clearly in error output', () => {
    expect(() => resolveSquadsChainsFromArgv(1)).to.throw(
      'Expected --chains to resolve to an array, but received number',
    );
  });

  it('labels null argv chains input clearly in error output', () => {
    expect(() => resolveSquadsChainsFromArgv(null)).to.throw(
      'Expected --chains to resolve to an array, but received null',
    );
  });

  it('labels object argv chains input clearly in error output', () => {
    expect(() => resolveSquadsChainsFromArgv({})).to.throw(
      'Expected --chains to resolve to an array, but received object',
    );
  });

  it('resolves argv chains from array input and deduplicates', () => {
    const [firstChain, secondChain] = getSquadsChains();
    expect(
      resolveSquadsChainsFromArgv([firstChain, secondChain, firstChain]),
    ).to.deep.equal([firstChain, secondChain]);
  });

  it('normalizes duplicate argv chain string values before resolving', () => {
    const [firstChain] = getSquadsChains();
    expect(
      resolveSquadsChainsFromArgv([firstChain, `${firstChain}`]),
    ).to.deep.equal([firstChain]);
  });

  it('rejects non-string argv chain values with index-aware errors', () => {
    expect(() => resolveSquadsChainsFromArgv([123])).to.throw(
      'Expected --chains[0] to be a string, but received number',
    );
  });

  it('accepts generic string arrays and validates squads support', () => {
    expect(() => resolveSquadsChains(['ethereum'])).to.throw(
      'Squads configuration not found for chains: ethereum',
    );
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
    expect(() => resolveSquadsChains(['ethereum'])).to.throw(
      'Squads configuration not found for chains: ethereum',
    );
  });

  it('includes available squads chains in unsupported-chain error', () => {
    const availableChains = getSquadsChains().join(', ');

    expect(() => resolveSquadsChains(['ethereum'])).to.throw(
      `Available Squads chains: ${availableChains}`,
    );
  });

  it('formats unsupported-chain error message with available chains', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['ethereum', 'arbitrum'],
        ['solanamainnet'],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum, arbitrum. Available Squads chains: solanamainnet',
    );
  });

  it('throws when unsupported-chain formatter receives empty chains list', () => {
    expect(() => getUnsupportedSquadsChainsErrorMessage([])).to.throw(
      'Expected at least one unsupported squads chain to format error message',
    );
  });

  it('throws when unsupported-chain formatter receives empty configured list', () => {
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum'], []),
    ).to.throw('Expected at least one configured squads chain');
  });

  it('deduplicates values in unsupported-chain error formatter', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['ethereum', 'ethereum'],
        ['solanamainnet', 'solanamainnet'],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum. Available Squads chains: solanamainnet',
    );
  });

  it('reports unsupported chains once when duplicates are provided', () => {
    expect(() =>
      resolveSquadsChains(['ethereum', 'ethereum', 'arbitrum']),
    ).to.throw('Squads configuration not found for chains: ethereum, arbitrum');
  });

  it('uses shared formatter output for unsupported explicit chains', () => {
    const configuredSquadsChains = getSquadsChains();
    const providedChains = [
      'ethereum',
      'ethereum',
      configuredSquadsChains[0],
      'arbitrum',
    ];
    const expectedErrorMessage = getUnsupportedSquadsChainsErrorMessage(
      ['ethereum', 'arbitrum'],
      configuredSquadsChains,
    );

    expect(() => resolveSquadsChains(providedChains)).to.throw(
      expectedErrorMessage,
    );
  });

  it('uses default configured squads chains when formatter list is omitted', () => {
    const availableChains = getSquadsChains().join(', ');

    expect(getUnsupportedSquadsChainsErrorMessage(['ethereum'])).to.equal(
      `Squads configuration not found for chains: ethereum. Available Squads chains: ${availableChains}`,
    );
  });

  it('returns a defensive copy for explicit chains', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = [firstChain, secondChain];
    const resolvedChains = resolveSquadsChains(selectedChains);

    resolvedChains.push(firstChain);

    expect(selectedChains).to.deep.equal([firstChain, secondChain]);
  });

  it('does not mutate caller input when explicit chains contain duplicates', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = [firstChain, secondChain, firstChain];

    void resolveSquadsChains(selectedChains);

    expect(selectedChains).to.deep.equal([firstChain, secondChain, firstChain]);
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

  it('parses chain alias when using required chain parser helper', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await parseArgs(
      withRequiredSquadsChain(yargs(['-c', chain])),
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

  it('rejects mixed squads and non-squads chains via parser choices', async () => {
    const chain = getSquadsChains()[0];
    let parserError: Error | undefined;
    try {
      await parseArgs(
        withSquadsChains(yargs(['--chains', chain, '--chains', 'ethereum'])),
      );
    } catch (error) {
      parserError = error as Error;
    }

    expect(parserError).to.not.be.undefined;
    expect(parserError?.message).to.include('Invalid values');
    expect(parserError?.message).to.include('ethereum');
  });
});
