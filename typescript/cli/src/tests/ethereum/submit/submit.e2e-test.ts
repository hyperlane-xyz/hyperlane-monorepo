import { expect } from 'chai';
import { PopulatedTransaction as EV5Transaction, ethers } from 'ethers';

import { XERC20VSTest, XERC20VSTest__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType, randomAddress } from '@hyperlane-xyz/sdk';
import { Address, randomInt } from '@hyperlane-xyz/utils';

import { CustomTxSubmitterType } from '../../../submitters/types.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployXERC20VSToken, hyperlaneSubmit } from '../commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
} from '../consts.js';

async function getMintOnlyOwnerTransaction(
  xerc20: XERC20VSTest,
  address: Address,
  amount: number,
  chainId: number,
): Promise<EV5Transaction> {
  const owner = await xerc20.owner();
  const iface = new ethers.utils.Interface(XERC20VSTest__factory.abi);
  const calldata = iface.encodeFunctionData('mintOnlyOwner', [address, amount]);
  return {
    data: calldata,
    to: xerc20.address,
    from: owner,
    chainId,
  };
}

async function expectUserBalances(
  users: Address[],
  xerc20Chains: XERC20VSTest[],
  balances: number[],
) {
  for (const [i, user] of Object.entries(users)) {
    const idx = Number(i);
    const xerc20 = xerc20Chains[idx];
    const balance = balances[idx];
    const userBalance = await xerc20.balanceOf(user);
    expect(userBalance).to.eql(ethers.BigNumber.from(balance));
  }
}

describe('hyperlane submit', function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  const ALICE = randomAddress();
  const BOB = randomAddress();
  const ANVIL2_CHAIN_ID = 31338;
  const ANVIL3_CHAIN_ID = 31347;
  let xerc20Chain2: XERC20VSTest;
  let xerc20Chain3: XERC20VSTest;
  before(async function () {
    xerc20Chain2 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      9,
      'TOKEN.E',
    );
    xerc20Chain3 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      9,
      'TOKEN.E',
    );
  });

  it('should execute an impersonated account strategy for multiple chains', async function () {
    const [xerc20Owner2, xerc20Owner3] = await Promise.all([
      xerc20Chain2.owner(),
      xerc20Chain3.owner(),
    ]);

    const impersonateStrategy = {
      [CHAIN_NAME_2]: {
        submitter: {
          chain: CHAIN_NAME_2,
          type: TxSubmitterType.IMPERSONATED_ACCOUNT,
          userAddress: xerc20Owner2,
        },
      },
      [CHAIN_NAME_3]: {
        submitter: {
          chain: CHAIN_NAME_3,
          type: TxSubmitterType.IMPERSONATED_ACCOUNT,
          userAddress: xerc20Owner3,
        },
      },
    };

    const strategyPath = `${TEMP_PATH}/impersonate-account-chain-strategy.yaml`;
    writeYamlOrJson(strategyPath, impersonateStrategy);

    const chain2MintAmount = randomInt(1, 1000);
    const chain3MintAmount = randomInt(1, 1000);
    const transactions = await Promise.all([
      getMintOnlyOwnerTransaction(
        xerc20Chain2,
        ALICE,
        chain2MintAmount,
        ANVIL2_CHAIN_ID,
      ),
      getMintOnlyOwnerTransaction(
        xerc20Chain3,
        BOB,
        chain3MintAmount,
        ANVIL3_CHAIN_ID,
      ),
    ]);
    const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
    writeYamlOrJson(transactionsPath, transactions);

    const users = [ALICE, BOB];
    const xerc20Chains = [xerc20Chain2, xerc20Chain3];

    await expectUserBalances(users, xerc20Chains, [0, 0]);
    await hyperlaneSubmit({ strategyPath, transactionsPath });
    await expectUserBalances(users, xerc20Chains, [
      chain2MintAmount,
      chain3MintAmount,
    ]);
  });

  it('should default to JSON RPC strategy if no strategy is provided', async function () {
    const chain2MintAmount = randomInt(1, 1000);
    const chain3MintAmount = randomInt(1, 1000);
    const transactions = await Promise.all([
      getMintOnlyOwnerTransaction(
        xerc20Chain2,
        ALICE,
        chain2MintAmount,
        ANVIL2_CHAIN_ID,
      ),
      getMintOnlyOwnerTransaction(
        xerc20Chain3,
        BOB,
        chain3MintAmount,
        ANVIL3_CHAIN_ID,
      ),
    ]);
    const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
    writeYamlOrJson(transactionsPath, transactions);

    const users = [ALICE, BOB];
    const xerc20Chains = [xerc20Chain2, xerc20Chain3];

    await expectUserBalances(users, xerc20Chains, [0, 0]);
    await hyperlaneSubmit({ transactionsPath });
    await expectUserBalances(users, xerc20Chains, [
      chain2MintAmount,
      chain3MintAmount,
    ]);
  });

  describe('FileSubmitter', function () {
    it('should execute a file strategy and append transactions to a file', async () => {
      // Generate a random-ish filename for local testing because FileSubmitterStrategy always appends so tests may fail
      const outputTransactionPath = `${TEMP_PATH}/transactions_${randomInt(0, 1_000_000)}.json`;
      const fileSubmitterStrategy = {
        [CHAIN_NAME_2]: {
          submitter: {
            type: CustomTxSubmitterType.FILE,
            filepath: outputTransactionPath,
          },
        },
        [CHAIN_NAME_3]: {
          submitter: {
            type: CustomTxSubmitterType.FILE,
            filepath: outputTransactionPath,
          },
        },
      };

      const strategyPath = `${TEMP_PATH}/file-strategy.yaml`;
      writeYamlOrJson(strategyPath, fileSubmitterStrategy);

      const chain2MintAmount = randomInt(1, 1000);
      const chain3MintAmount = randomInt(1, 1000);
      const transactions = await Promise.all([
        getMintOnlyOwnerTransaction(
          xerc20Chain2,
          ALICE,
          chain2MintAmount,
          ANVIL2_CHAIN_ID,
        ),
        getMintOnlyOwnerTransaction(
          xerc20Chain3,
          BOB,
          chain3MintAmount,
          ANVIL3_CHAIN_ID,
        ),
      ]);
      const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
      writeYamlOrJson(transactionsPath, transactions);

      await hyperlaneSubmit({ strategyPath, transactionsPath });

      const outputtedTransactions = readYamlOrJson(outputTransactionPath);
      expect(outputtedTransactions).to.deep.equal(transactions);
    });

    it('should overwrite a transactions file if it is malformed (not array)', async () => {
      const outputTransactionPath = `${TEMP_PATH}/transactions_${randomInt(0, 1_000_000)}.json`;
      const fileSubmitterStrategy = {
        [CHAIN_NAME_2]: {
          submitter: {
            type: CustomTxSubmitterType.FILE,
            filepath: outputTransactionPath,
          },
        },
      };

      const strategyPath = `${TEMP_PATH}/file-strategy.yaml`;
      writeYamlOrJson(strategyPath, fileSubmitterStrategy);

      // Add an invalid transaction object (we expect arrays)
      const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
      writeYamlOrJson(transactionsPath, { invalid: 'transaction' });

      const chain2MintAmount = randomInt(1, 1000);
      const transactions = await Promise.all([
        getMintOnlyOwnerTransaction(
          xerc20Chain2,
          ALICE,
          chain2MintAmount,
          ANVIL2_CHAIN_ID,
        ),
      ]);
      writeYamlOrJson(transactionsPath, transactions);

      await hyperlaneSubmit({ strategyPath, transactionsPath });
      const outputtedTransactions = readYamlOrJson(outputTransactionPath);
      expect(outputtedTransactions).to.deep.equal(transactions);
    });
  });
});
