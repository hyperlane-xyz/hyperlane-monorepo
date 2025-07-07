import { hyperlaneSubmit } from '../commands/helpers.js';

describe.only('hyperlane submit', function () {
  const strategyPath =
    './examples/submit/strategy/impersonated-account-chain-strategy.yaml';
  const transactionsPath =
    './examples/submit/transactions/anvil-transactions.yaml';
  // );
  it('should execute transactions', async function () {
    await hyperlaneSubmit({ strategyPath, transactionsPath });
  });
  xit('should output receipts', function () {});
});
