import { expect } from 'chai';

import {
  executePendingTransactions,
  processGovernorReaderResult,
} from '../src/tx/utils.js';

interface PendingTxFixture {
  id: string;
  chain: string;
  shouldFail?: boolean;
}

describe('executePendingTransactions', () => {
  it('throws when executable transactions input is not an array', async () => {
    try {
      await executePendingTransactions(
        123 as unknown as PendingTxFixture[],
        (tx) => tx.id,
        (tx) => tx.chain,
        async () => undefined,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Executable transactions must be an array: 123',
      );
    }
  });

  it('throws when callback inputs are invalid', async () => {
    try {
      await executePendingTransactions(
        [],
        null as unknown as (tx: PendingTxFixture) => string,
        (tx) => tx.chain,
        async () => undefined,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'txId must be a function: null',
      );
    }

    try {
      await executePendingTransactions(
        [],
        (tx) => tx.id,
        null as unknown as (tx: PendingTxFixture) => string,
        async () => undefined,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'txChain must be a function: null',
      );
    }

    try {
      await executePendingTransactions(
        [],
        (tx) => tx.id,
        (tx) => tx.chain,
        null as unknown as (tx: PendingTxFixture) => Promise<void>,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'executeTx must be a function: null',
      );
    }
  });

  it('throws when executable transaction length is inaccessible', async () => {
    const txsWithThrowingLength = new Proxy([{ id: 'tx1', chain: 'chainA' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('boom');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      await executePendingTransactions(
        txsWithThrowingLength as unknown as PendingTxFixture[],
        (tx) => tx.id,
        (tx) => tx.chain,
        async () => undefined,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Executable transactions length is inaccessible',
      );
    }
  });

  it('throws when executable transaction length is invalid', async () => {
    const txsWithInvalidLength = new Proxy([{ id: 'tx1', chain: 'chainA' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.POSITIVE_INFINITY;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      await executePendingTransactions(
        txsWithInvalidLength as unknown as PendingTxFixture[],
        (tx) => tx.id,
        (tx) => tx.chain,
        async () => undefined,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Executable transactions length is invalid: Infinity',
      );
    }
  });

  it('throws when confirmPrompt input is invalid', async () => {
    try {
      await executePendingTransactions(
        [],
        (tx: PendingTxFixture) => tx.id,
        (tx: PendingTxFixture) => tx.chain,
        async () => undefined,
        null as unknown as (options: {
          message: string;
          default: boolean;
        }) => Promise<boolean>,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'confirmPrompt must be a function: null',
      );
    }
  });

  it('continues executing transactions after individual failures', async () => {
    const txs: PendingTxFixture[] = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB', shouldFail: true },
      { id: 'tx3', chain: 'chainC' },
    ];
    const executed: string[] = [];

    const confirmPrompt = async () => true;
    const executeTx = async (tx: PendingTxFixture) => {
      executed.push(tx.id);
      if (tx.shouldFail) {
        throw new Error(`boom-${tx.id}`);
      }
    };

    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        executeTx,
        confirmPrompt,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainB:tx2',
      );
    }

    expect(executed).to.deep.equal(['tx1', 'tx2', 'tx3']);
  });

  it('uses execute-all confirmation to avoid per-transaction prompts', async () => {
    const txs: PendingTxFixture[] = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    let promptCalls = 0;

    await executePendingTransactions(
      txs,
      (tx) => tx.id,
      (tx) => tx.chain,
      async (tx) => {
        executed.push(tx.id);
      },
      async () => {
        promptCalls += 1;
        return true;
      },
    );

    expect(executed).to.deep.equal(['tx1', 'tx2']);
    expect(promptCalls).to.equal(1);
  });

  it('respects per-transaction confirmations when execute-all is declined', async () => {
    const txs: PendingTxFixture[] = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
      { id: 'tx3', chain: 'chainC' },
    ];
    const executed: string[] = [];
    const responses = [false, true, false, true];

    const confirmPrompt = async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error('Unexpected prompt invocation');
      }
      return response;
    };

    await executePendingTransactions(
      txs,
      (tx) => tx.id,
      (tx) => tx.chain,
      async (tx) => {
        executed.push(tx.id);
      },
      confirmPrompt,
    );

    expect(executed).to.deep.equal(['tx1', 'tx3']);
    expect(responses).to.deep.equal([]);
  });

  it('summarizes multiple failed transactions in thrown error', async () => {
    const txs: PendingTxFixture[] = [
      { id: 'tx1', chain: 'chainA', shouldFail: true },
      { id: 'tx2', chain: 'chainB' },
      { id: 'tx3', chain: 'chainC', shouldFail: true },
    ];

    const confirmPrompt = async () => true;
    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          if (tx.shouldFail) {
            throw new Error(`boom-${tx.id}`);
          }
        },
        confirmPrompt,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 2 transaction(s): chainA:tx1, chainC:tx3',
      );
    }
  });

  it('continues when transaction metadata derivation throws', async () => {
    const txs = [{ id: 'tx1' }, { id: 'tx2' }, { id: 'tx3' }];
    const executed: string[] = [];

    const confirmPrompt = async () => true;
    try {
      await executePendingTransactions(
        txs,
        (tx) => {
          if (tx.id === 'tx2') {
            throw new Error('cannot derive id');
          }
          return tx.id;
        },
        (tx) => `chain-${tx.id}`,
        async (tx) => {
          executed.push(tx.id);
        },
        confirmPrompt,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): <unknown>:<unknown>',
      );
    }

    expect(executed).to.deep.equal(['tx1', 'tx3']);
  });

  it('returns immediately when there are no executable transactions', async () => {
    let promptCalls = 0;

    await executePendingTransactions(
      [],
      () => 'unused',
      () => 'unused',
      async () => {
        throw new Error('executeTx should not be called');
      },
      async () => {
        promptCalls += 1;
        return true;
      },
    );

    expect(promptCalls).to.equal(0);
  });

  it('continues when transaction metadata is invalid', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: '' },
    ];
    const executed: string[] = [];

    const confirmPrompt = async () => true;
    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        confirmPrompt,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): <unknown>:tx2',
      );
    }

    expect(executed).to.deep.equal(['tx1']);
  });

  it('continues when transaction entry access throws', async () => {
    const txsWithThrowingEntry = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    Object.defineProperty(txsWithThrowingEntry, '1', {
      get() {
        throw new Error('entry boom');
      },
    });
    const executed: string[] = [];

    try {
      await executePendingTransactions(
        txsWithThrowingEntry as unknown as PendingTxFixture[],
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        async () => true,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): <unknown>:<unknown>',
      );
    }

    expect(executed).to.deep.equal(['tx1']);
  });

  it('continues when transaction entry is empty', async () => {
    const txsWithEmptyEntry = [{ id: 'tx1', chain: 'chainA' }, undefined];
    const executed: string[] = [];

    try {
      await executePendingTransactions(
        txsWithEmptyEntry as unknown as PendingTxFixture[],
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        async () => true,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): <unknown>:<unknown>',
      );
    }

    expect(executed).to.deep.equal(['tx1']);
  });

  it('records partial metadata when id is invalid but chain is present', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: '   ', chain: 'chainB' },
    ];
    const executed: string[] = [];

    const confirmPrompt = async () => true;
    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        confirmPrompt,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainB:<unknown>',
      );
    }

    expect(executed).to.deep.equal(['tx1']);
  });

  it('continues when per-transaction confirmation prompt throws', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
      { id: 'tx3', chain: 'chainC' },
    ];
    const executed: string[] = [];
    const promptSteps = ['execute-all', 'tx1', 'tx2', 'tx3'] as const;
    let promptIndex = 0;

    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        async () => {
          const step = promptSteps[promptIndex];
          promptIndex += 1;
          if (step === 'execute-all') return false;
          if (step === 'tx2') throw new Error('prompt failed');
          return true;
        },
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainB:tx2',
      );
    }

    expect(executed).to.deep.equal(['tx1', 'tx3']);
  });

  it('falls back to per-transaction prompts when execute-all prompt fails', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    const promptSteps = ['execute-all', 'tx1', 'tx2'] as const;
    let promptIndex = 0;

    await executePendingTransactions(
      txs,
      (tx) => tx.id,
      (tx) => tx.chain,
      async (tx) => {
        executed.push(tx.id);
      },
      async () => {
        const step = promptSteps[promptIndex];
        promptIndex += 1;
        if (step === 'execute-all') throw new Error('prompt init failed');
        return true;
      },
    );

    expect(executed).to.deep.equal(['tx1', 'tx2']);
  });

  it('falls back to per-transaction prompts when execute-all prompt is non-boolean', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    const promptSteps = ['execute-all', 'tx1', 'tx2'] as const;
    let promptIndex = 0;

    await executePendingTransactions(
      txs,
      (tx) => tx.id,
      (tx) => tx.chain,
      async (tx) => {
        executed.push(tx.id);
      },
      async () => {
        const step = promptSteps[promptIndex];
        promptIndex += 1;
        if (step === 'execute-all') return 'yes';
        return true;
      },
    );

    expect(executed).to.deep.equal(['tx1', 'tx2']);
  });

  it('falls back to per-transaction prompts when execute-all prompt is unstringifiable', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    const promptSteps = ['execute-all', 'tx1', 'tx2'] as const;
    let promptIndex = 0;
    const unstringifiableResponse = {
      [Symbol.toPrimitive]() {
        throw new Error('to-primitive boom');
      },
    };

    await executePendingTransactions(
      txs,
      (tx) => tx.id,
      (tx) => tx.chain,
      async (tx) => {
        executed.push(tx.id);
      },
      async () => {
        const step = promptSteps[promptIndex];
        promptIndex += 1;
        if (step === 'execute-all') {
          return unstringifiableResponse as unknown as boolean;
        }
        return true;
      },
    );

    expect(executed).to.deep.equal(['tx1', 'tx2']);
  });

  it('records failure when execute-all prompt returns non-boolean and tx prompt also fails', async () => {
    const txs = [{ id: 'tx1', chain: 'chainA' }];
    let promptCalls = 0;

    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async () => {
          throw new Error('executeTx should not be called');
        },
        async () => {
          promptCalls += 1;
          if (promptCalls === 1) return 'yes';
          throw new Error('tx prompt failed');
        },
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainA:tx1',
      );
    }
    expect(promptCalls).to.equal(2);
  });

  it('records failure when per-transaction prompt returns non-boolean', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    const promptSteps = ['execute-all', 'tx1', 'tx2'] as const;
    let promptIndex = 0;

    try {
      await executePendingTransactions(
        txs,
        (tx) => tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        async () => {
          const step = promptSteps[promptIndex];
          promptIndex += 1;
          if (step === 'execute-all') return false;
          if (step === 'tx1') return true;
          return 'y';
        },
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainB:tx2',
      );
    }

    expect(executed).to.deep.equal(['tx1']);
  });

  it('continues when invalid metadata values are unstringifiable', async () => {
    const txs = [
      { id: 'tx1', chain: 'chainA' },
      { id: 'tx2', chain: 'chainB' },
    ];
    const executed: string[] = [];
    const unstringifiableId = {
      [Symbol.toPrimitive]() {
        throw new Error('metadata to-primitive boom');
      },
    };

    try {
      await executePendingTransactions(
        txs,
        (tx) =>
          tx.id === 'tx1' ? (unstringifiableId as unknown as string) : tx.id,
        (tx) => tx.chain,
        async (tx) => {
          executed.push(tx.id);
        },
        async () => true,
      );
      expect.fail('Expected executePendingTransactions to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Failed to execute 1 transaction(s): chainA:<unknown>',
      );
    }

    expect(executed).to.deep.equal(['tx2']);
  });
});

describe('processGovernorReaderResult', () => {
  it('throws when result input is not an array', () => {
    expect(() =>
      processGovernorReaderResult(
        123 as unknown as [string, any][],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader result must be an array: 123');
  });

  it('throws when errors input is not an array', () => {
    expect(() =>
      processGovernorReaderResult(
        [],
        null as unknown as any[],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader errors must be an array: null');
  });

  it('throws when result length is inaccessible', () => {
    const resultWithThrowingLength = new Proxy(
      [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('boom');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      processGovernorReaderResult(
        resultWithThrowingLength as unknown as [string, any][],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader result length is inaccessible');
  });

  it('throws when errors length is invalid', () => {
    const errorsWithInvalidLength = new Proxy([{ message: 'fatal' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.POSITIVE_INFINITY;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
        errorsWithInvalidLength as unknown as any[],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader errors length is invalid: Infinity');
  });

  it('throws when errors length is inaccessible', () => {
    const errorsWithThrowingLength = new Proxy([{ message: 'fatal' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('boom');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
        errorsWithThrowingLength as unknown as any[],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader errors length is inaccessible');
  });

  it('throws when output file name is invalid', () => {
    expect(() => processGovernorReaderResult([], [], '   ')).to.throw(
      'Governor reader output file name must be a non-empty string:    ',
    );
  });

  it('throws when injected dependency functions are invalid', () => {
    expect(() =>
      processGovernorReaderResult([], [], 'safe-tx-parse-results', {
        writeYamlFn: null as unknown as any,
      }),
    ).to.throw('Governor reader writeYamlFn must be a function: null');

    expect(() =>
      processGovernorReaderResult([], [], 'safe-tx-parse-results', {
        nowFn: null as unknown as any,
      }),
    ).to.throw('Governor reader nowFn must be a function: null');

    expect(() =>
      processGovernorReaderResult([], [], 'safe-tx-parse-results', {
        exitFn: null as unknown as any,
      }),
    ).to.throw('Governor reader exitFn must be a function: null');
  });

  it('throws when nowFn throws while generating timestamp', () => {
    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
        [],
        'safe-tx-parse-results',
        {
          nowFn: () => {
            throw new Error('clock boom');
          },
        },
      ),
    ).to.throw('Governor reader timestamp generation failed');
  });

  it('throws when nowFn returns invalid timestamp', () => {
    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
        [],
        'safe-tx-parse-results',
        {
          nowFn: () => Number.POSITIVE_INFINITY,
        },
      ),
    ).to.throw('Governor reader timestamp is invalid: Infinity');
  });

  it('throws when result entry access is inaccessible', () => {
    const resultWithThrowingEntry = [
      ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
    ];
    Object.defineProperty(resultWithThrowingEntry, '0', {
      get() {
        throw new Error('entry boom');
      },
    });

    expect(() =>
      processGovernorReaderResult(
        resultWithThrowingEntry as unknown as [string, any][],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader result entry at index 0 is inaccessible');
  });

  it('throws when result entry length is inaccessible', () => {
    const resultEntry = new Proxy(
      ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('entry length boom');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const resultWithThrowingEntryLength = [resultEntry];

    expect(() =>
      processGovernorReaderResult(
        resultWithThrowingEntryLength as unknown as [string, any][],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw(
      'Governor reader result entry length at index 0 is inaccessible',
    );
  });

  it('throws when result entry length is invalid', () => {
    const resultEntry = new Proxy(
      ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            return Number.POSITIVE_INFINITY;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const resultWithInvalidEntryLength = [resultEntry];

    expect(() =>
      processGovernorReaderResult(
        resultWithInvalidEntryLength as unknown as [string, any][],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw(
      'Governor reader result entry length at index 0 is invalid: Infinity',
    );
  });

  it('throws when result entry key is invalid', () => {
    expect(() =>
      processGovernorReaderResult(
        [[123 as unknown as string, { status: 'ok' } as unknown as any]],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw(
      'Governor reader result key at index 0 must be a non-empty string: 123',
    );
  });

  it('throws when result entry values are inaccessible', () => {
    const resultEntry = new Proxy(
      ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
      {
        get(target, property, receiver) {
          if (property === '0') {
            throw new Error('entry value boom');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      processGovernorReaderResult(
        [resultEntry as unknown as [string, any]],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw(
      'Governor reader result entry values at index 0 are inaccessible',
    );
  });

  it('throws when result keys are duplicated', () => {
    expect(() =>
      processGovernorReaderResult(
        [
          ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
          ['chainA-1-0xabc', { status: 'ok' } as unknown as any],
        ],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw(
      'Governor reader result key at index 1 is duplicated: chainA-1-0xabc',
    );
  });

  it('throws when result transaction is undefined', () => {
    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', undefined as unknown as any]],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader transaction at index 0 must be defined');
  });

  it('throws when result transaction is null', () => {
    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', null as unknown as any]],
        [],
        'safe-tx-parse-results',
      ),
    ).to.throw('Governor reader transaction at index 0 must be defined');
  });

  it('writes result yaml and does not exit when there are no fatal errors', () => {
    let writtenPath: string | undefined;
    let writtenValue: Record<string, unknown> | undefined;
    let exitCode: number | undefined;

    processGovernorReaderResult(
      [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
      [],
      'safe-tx-parse-results',
      {
        nowFn: () => 1700000000000,
        writeYamlFn: (path, value) => {
          writtenPath = path;
          writtenValue = value as Record<string, unknown>;
        },
        exitFn: (code) => {
          exitCode = code;
        },
      },
    );

    expect(writtenPath).to.equal('safe-tx-parse-results-1700000000000.yaml');
    expect(writtenValue).to.deep.equal({
      'chainA-1-0xabc': { status: 'ok' },
    });
    expect(exitCode).to.equal(undefined);
  });

  it('throws when writing result yaml fails', () => {
    expect(() =>
      processGovernorReaderResult(
        [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
        [],
        'safe-tx-parse-results',
        {
          nowFn: () => 1700000000000,
          writeYamlFn: () => {
            throw new Error('disk failed');
          },
        },
      ),
    ).to.throw(
      'Governor reader failed to write results file safe-tx-parse-results-1700000000000.yaml: Error: disk failed',
    );
  });

  it('exits with code 1 when fatal errors are present', () => {
    let writtenPath: string | undefined;
    let exitCode: number | undefined;

    processGovernorReaderResult(
      [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
      [{ message: 'fatal' }],
      'safe-tx-parse-results',
      {
        nowFn: () => 1700000000000,
        writeYamlFn: (path) => {
          writtenPath = path;
        },
        exitFn: (code) => {
          exitCode = code;
        },
      },
    );

    expect(writtenPath).to.equal('safe-tx-parse-results-1700000000000.yaml');
    expect(exitCode).to.equal(1);
  });

  it('trims output file name before writing results', () => {
    let writtenPath: string | undefined;

    processGovernorReaderResult(
      [['chainA-1-0xabc', { status: 'ok' } as unknown as any]],
      [],
      '  safe-tx-parse-results  ',
      {
        nowFn: () => 1700000000000,
        writeYamlFn: (path) => {
          writtenPath = path;
        },
      },
    );

    expect(writtenPath).to.equal('safe-tx-parse-results-1700000000000.yaml');
  });
});
