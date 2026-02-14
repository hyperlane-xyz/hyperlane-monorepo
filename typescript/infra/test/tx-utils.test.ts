import { expect } from 'chai';

import { executePendingTransactions } from '../src/tx/utils.js';

interface PendingTxFixture {
  id: string;
  chain: string;
  shouldFail?: boolean;
}

describe('executePendingTransactions', () => {
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
});
