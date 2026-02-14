import { expect } from 'chai';
import yargs, { type Argv } from 'yargs';

import { getSquadsChains } from '@hyperlane-xyz/sdk';

import {
  getUnsupportedSquadsChainsErrorMessage,
  resolveSquadsChains,
  resolveSquadsChainsFromArgv,
  withRequiredSquadsChain,
  withTransactionIndex,
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

async function expectParseError(args: Argv, expectedMessage: string) {
  const parserError = await getParseError(args);
  expect(parserError.message).to.include(expectedMessage);
}

async function getParseError(args: Argv): Promise<Error> {
  let parserError: Error | undefined;
  try {
    await parseArgs(args);
  } catch (error) {
    parserError = error as Error;
  }

  if (!parserError) {
    throw new Error('Expected parser to throw an error');
  }

  return parserError;
}

describe('squads cli helpers', () => {
  it('resolves to configured squads chains when undefined', () => {
    expect(resolveSquadsChains(undefined)).to.deep.equal(getSquadsChains());
  });

  it('resolves to configured squads chains when empty list', () => {
    expect(resolveSquadsChains([])).to.deep.equal(getSquadsChains());
  });

  it('returns a fresh default squads chains array reference per call', () => {
    const firstResolvedChains = resolveSquadsChains(undefined);
    const secondResolvedChains = resolveSquadsChains(undefined);

    expect(firstResolvedChains).to.not.equal(secondResolvedChains);
  });

  it('resolves argv chains from undefined input to configured squads chains', () => {
    expect(resolveSquadsChainsFromArgv(undefined)).to.deep.equal(
      getSquadsChains(),
    );
  });

  it('returns a fresh default argv chains array reference per call', () => {
    const firstResolvedChains = resolveSquadsChainsFromArgv(undefined);
    const secondResolvedChains = resolveSquadsChainsFromArgv(undefined);

    expect(firstResolvedChains).to.not.equal(secondResolvedChains);
  });

  it('returns a fresh default argv chains array for empty array input', () => {
    const firstResolvedChains = resolveSquadsChainsFromArgv([]);
    const secondResolvedChains = resolveSquadsChainsFromArgv([]);

    expect(firstResolvedChains).to.not.equal(secondResolvedChains);
  });

  it('resolves argv chains from empty array input to configured squads chains', () => {
    expect(resolveSquadsChainsFromArgv([])).to.deep.equal(getSquadsChains());
  });

  const invalidArgvChainsContainerCases: Array<{
    title: string;
    chainsValue: unknown;
    expectedType: string;
  }> = [
    {
      title: 'throws for non-array argv chains input when provided',
      chainsValue: 'solanamainnet',
      expectedType: 'string',
    },
    {
      title: 'labels numeric argv chains input clearly in error output',
      chainsValue: 1,
      expectedType: 'number',
    },
    {
      title: 'labels null argv chains input clearly in error output',
      chainsValue: null,
      expectedType: 'null',
    },
    {
      title: 'labels object argv chains input clearly in error output',
      chainsValue: {},
      expectedType: 'object',
    },
    {
      title: 'labels boolean argv chains input clearly in error output',
      chainsValue: false,
      expectedType: 'boolean',
    },
    {
      title: 'labels bigint argv chains input clearly in error output',
      chainsValue: 1n,
      expectedType: 'bigint',
    },
    {
      title: 'labels symbol argv chains input clearly in error output',
      chainsValue: Symbol('invalid-chains'),
      expectedType: 'symbol',
    },
    {
      title: 'labels function argv chains input clearly in error output',
      chainsValue: () => ['invalid-chains'],
      expectedType: 'function',
    },
  ];

  for (const { title, chainsValue, expectedType } of invalidArgvChainsContainerCases) {
    it(title, () => {
      expect(() => resolveSquadsChainsFromArgv(chainsValue)).to.throw(
        `Expected --chains to resolve to an array, but received ${expectedType}`,
      );
    });
  }

  it('resolves argv chains from array input and deduplicates', () => {
    const [firstChain, secondChain] = getSquadsChains();
    expect(
      resolveSquadsChainsFromArgv([firstChain, secondChain, firstChain]),
    ).to.deep.equal([firstChain, secondChain]);
  });

  it('resolves frozen argv chains arrays without mutating input', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const argvChains = Object.freeze([
      firstChain,
      secondChain,
      firstChain,
    ]) as readonly unknown[];

    expect(resolveSquadsChainsFromArgv(argvChains)).to.deep.equal([
      firstChain,
      secondChain,
    ]);
  });

  it('normalizes duplicate argv chain string values before resolving', () => {
    const [firstChain] = getSquadsChains();
    expect(
      resolveSquadsChainsFromArgv([firstChain, `${firstChain}`]),
    ).to.deep.equal([firstChain]);
  });

  it('trims argv chain string values before resolving', () => {
    const [firstChain] = getSquadsChains();
    expect(resolveSquadsChainsFromArgv([` ${firstChain} `])).to.deep.equal([
      firstChain,
    ]);
  });

  it('rejects non-string argv chain values with index-aware errors', () => {
    expect(() => resolveSquadsChainsFromArgv([123])).to.throw(
      'Expected --chains[0] to be a string, but received number',
    );
  });

  const invalidArgvChainTypeCases: Array<{
    title: string;
    chainValue: unknown;
    expectedType: string;
  }> = [
    {
      title: 'labels null argv chain values clearly in index-aware errors',
      chainValue: null,
      expectedType: 'null',
    },
    {
      title: 'labels object argv chain values clearly in index-aware errors',
      chainValue: {},
      expectedType: 'object',
    },
    {
      title: 'labels array argv chain values clearly in index-aware errors',
      chainValue: [],
      expectedType: 'array',
    },
    {
      title: 'labels boolean argv chain values clearly in index-aware errors',
      chainValue: false,
      expectedType: 'boolean',
    },
    {
      title: 'labels bigint argv chain values clearly in index-aware errors',
      chainValue: 1n,
      expectedType: 'bigint',
    },
    {
      title: 'labels symbol argv chain values clearly in index-aware errors',
      chainValue: Symbol('invalid-chain'),
      expectedType: 'symbol',
    },
    {
      title: 'labels function argv chain values clearly in index-aware errors',
      chainValue: () => 'invalid-chain',
      expectedType: 'function',
    },
  ];

  for (const { title, chainValue, expectedType } of invalidArgvChainTypeCases) {
    it(title, () => {
      expect(() => resolveSquadsChainsFromArgv([chainValue])).to.throw(
        `Expected --chains[0] to be a string, but received ${expectedType}`,
      );
    });
  }

  it('rejects empty argv chain string values with index-aware errors', () => {
    expect(() => resolveSquadsChainsFromArgv(['   '])).to.throw(
      'Expected --chains[0] to be a non-empty string',
    );
  });

  it('reports the exact index for empty argv chain string values', () => {
    const [chain] = getSquadsChains();
    expect(() => resolveSquadsChainsFromArgv([chain, '   '])).to.throw(
      'Expected --chains[1] to be a non-empty string',
    );
  });

  it('reports the exact index for non-string argv chain values', () => {
    const [chain] = getSquadsChains();
    expect(() => resolveSquadsChainsFromArgv([chain, 123])).to.throw(
      'Expected --chains[1] to be a string, but received number',
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

  it('resolves readonly frozen explicit chains without mutating input', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = Object.freeze([
      firstChain,
      secondChain,
      firstChain,
    ]) as readonly unknown[];

    expect(resolveSquadsChains(selectedChains)).to.deep.equal([
      firstChain,
      secondChain,
    ]);
  });

  it('deduplicates explicitly provided chains while preserving order', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const selectedChains = [firstChain, secondChain, firstChain];

    expect(resolveSquadsChains(selectedChains)).to.deep.equal([
      firstChain,
      secondChain,
    ]);
  });

  it('trims explicitly provided chains before resolving', () => {
    const [firstChain] = getSquadsChains();
    expect(resolveSquadsChains([` ${firstChain} `])).to.deep.equal([
      firstChain,
    ]);
  });

  it('throws for explicitly provided empty chain values', () => {
    expect(() => resolveSquadsChains(['   '])).to.throw(
      'Expected chains[0] to be a non-empty string',
    );
  });

  it('throws for explicitly provided non-string chain values', () => {
    expect(() => resolveSquadsChains([123])).to.throw(
      'Expected chains[0] to be a string, but received number',
    );
  });

  const invalidProvidedChainTypeCases: Array<{
    title: string;
    chainValue: unknown;
    expectedType: string;
  }> = [
    {
      title: 'labels null values in explicitly provided chains errors',
      chainValue: null,
      expectedType: 'null',
    },
    {
      title: 'labels object values in explicitly provided chains errors',
      chainValue: {},
      expectedType: 'object',
    },
    {
      title: 'labels array values in explicitly provided chains errors',
      chainValue: [],
      expectedType: 'array',
    },
    {
      title: 'labels boolean values in explicitly provided chains errors',
      chainValue: false,
      expectedType: 'boolean',
    },
    {
      title: 'labels symbol values in explicitly provided chains errors',
      chainValue: Symbol('invalid-chain'),
      expectedType: 'symbol',
    },
    {
      title: 'labels function values in explicitly provided chains errors',
      chainValue: () => 'invalid-chain',
      expectedType: 'function',
    },
    {
      title: 'labels bigint values in explicitly provided chains errors',
      chainValue: 1n,
      expectedType: 'bigint',
    },
  ];

  for (const { title, chainValue, expectedType } of invalidProvidedChainTypeCases) {
    it(title, () => {
      expect(() => resolveSquadsChains([chainValue])).to.throw(
        `Expected chains[0] to be a string, but received ${expectedType}`,
      );
    });
  }

  it('reports exact index for explicitly provided non-string chain values', () => {
    const [chain] = getSquadsChains();
    expect(() => resolveSquadsChains([chain, 123])).to.throw(
      'Expected chains[1] to be a string, but received number',
    );
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

  it('formats empty chain names explicitly in unsupported-chain formatter', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage([''], ['solanamainnet', '']),
    ).to.equal(
      'Squads configuration not found for chains: <empty>. Available Squads chains: solanamainnet, <empty>',
    );
  });

  it('formats whitespace-only chain names as empty and deduplicates display values', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage([' ', ''], ['solanamainnet', '']),
    ).to.equal(
      'Squads configuration not found for chains: <empty>. Available Squads chains: solanamainnet, <empty>',
    );
  });

  it('trims chain names in unsupported-chain formatter output', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        [' ethereum '],
        [' solanamainnet '],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum. Available Squads chains: solanamainnet',
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

  it('trims chain parser values before validation', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await parseArgs(
      withSquadsChain(yargs(['--chain', ` ${chain} `])),
    );

    expect(parsedArgs.chain).to.equal(chain);
  });

  it('rejects non-squads chain via chain parser choices', async () => {
    await expectParseError(
      withSquadsChain(yargs(['--chain', 'ethereum'])),
      'Invalid values',
    );
  });

  it('rejects empty chain parser values with clear error', async () => {
    await expectParseError(
      withSquadsChain(yargs(['--chain', '   '])),
      'Expected --chain to be a non-empty string',
    );
  });

  it('requires chain when using required chain parser helper', async () => {
    await expectParseError(
      withRequiredSquadsChain(yargs([])),
      'Missing required argument: chain',
    );
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

  it('requires transaction index when using transaction index parser helper', async () => {
    await expectParseError(
      withTransactionIndex(yargs([])),
      'Missing required argument: transactionIndex',
    );
  });

  it('parses transaction index when using transaction index parser helper', async () => {
    const parsedArgs = await parseArgs(
      withTransactionIndex(yargs(['--transactionIndex', '5'])),
    );

    expect(parsedArgs.transactionIndex).to.equal(5);
  });

  it('parses transaction index from t alias', async () => {
    const parsedArgs = await parseArgs(withTransactionIndex(yargs(['-t', '7'])));

    expect(parsedArgs.transactionIndex).to.equal(7);
  });

  it('rejects non-finite transaction index values', async () => {
    await expectParseError(
      withTransactionIndex(yargs(['--transactionIndex', 'abc'])),
      'Expected --transactionIndex to be a finite number, but received NaN',
    );
  });

  it('rejects non-integer transaction index values', async () => {
    await expectParseError(
      withTransactionIndex(yargs(['--transactionIndex', '1.5'])),
      'Expected --transactionIndex to be a safe integer, but received 1.5',
    );
  });

  it('rejects negative transaction index values', async () => {
    await expectParseError(
      withTransactionIndex(yargs(['--transactionIndex', '-1'])),
      'Expected --transactionIndex to be a non-negative integer, but received -1',
    );
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

  it('trims chains parsed from repeated args before dedupe', async () => {
    const chain = getSquadsChains()[0];

    const parsedArgs = await parseArgs(
      withSquadsChains(yargs(['--chains', ` ${chain} `, '--chains', chain])),
    );

    expect(parsedArgs.chains).to.deep.equal([chain]);
  });

  it('rejects non-squads chain via chains parser choices', async () => {
    await expectParseError(
      withSquadsChains(yargs(['--chains', 'ethereum'])),
      'Invalid values',
    );
  });

  it('rejects mixed squads and non-squads chains via parser choices', async () => {
    const chain = getSquadsChains()[0];
    const parserError = await getParseError(
      withSquadsChains(yargs(['--chains', chain, '--chains', 'ethereum'])),
    );
    expect(parserError.message).to.include('Invalid values');
    expect(parserError.message).to.include('ethereum');
  });

  it('rejects empty chains values via parser coercion', async () => {
    await expectParseError(
      withSquadsChains(yargs(['--chains', '   '])),
      'Expected --chains[0] to be a non-empty string',
    );
  });
});
