import { expect } from 'chai';
import { type PopulatedTransaction as EV5Transaction, ethers } from 'ethers';

import {
  MockSafe__factory,
  type XERC20VSTest,
  XERC20VSTest__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType, randomAddress } from '@hyperlane-xyz/sdk';
import { type Address, randomInt } from '@hyperlane-xyz/utils';

import { EV5FileSubmitter } from '../../../submitters/EV5FileSubmitter.js';
import { CustomTxSubmitterType } from '../../../submitters/types.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  createMockSafeApi,
  deployXERC20VSToken,
  hyperlaneSubmit,
} from '../commands/helpers.js';
import { TEST_CHAIN_METADATA_BY_PROTOCOL } from '../../constants.js';
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

    const initialBalances = await Promise.all(
      users.map((user, i) => xerc20Chains[i].balanceOf(user)),
    );
    await hyperlaneSubmit({ strategyPath, transactionsPath });
    await expectUserBalances(users, xerc20Chains, [
      initialBalances[0].add(chain2MintAmount).toNumber(),
      initialBalances[1].add(chain3MintAmount).toNumber(),
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

    const initialBalances = await Promise.all(
      users.map((user, i) => xerc20Chains[i].balanceOf(user)),
    );
    await hyperlaneSubmit({ transactionsPath });
    await expectUserBalances(users, xerc20Chains, [
      initialBalances[0].add(chain2MintAmount).toNumber(),
      initialBalances[1].add(chain3MintAmount).toNumber(),
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

    it('should serialize parallel writes to the same file', async () => {
      const outputTransactionPath = `${TEMP_PATH}/transactions_${randomInt(0, 1_000_000)}.json`;
      const submitterA = new EV5FileSubmitter({
        chain: CHAIN_NAME_2,
        filepath: outputTransactionPath,
      });
      const submitterB = new EV5FileSubmitter({
        chain: CHAIN_NAME_3,
        filepath: outputTransactionPath,
      });

      const chain2MintAmount = randomInt(1, 1000);
      const chain3MintAmount = randomInt(1, 1000);
      const [tx1, tx2] = await Promise.all([
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

      await Promise.all([submitterA.submit(tx1), submitterB.submit(tx2)]);

      const outputtedTransactions = readYamlOrJson(outputTransactionPath);
      expect(outputtedTransactions).to.have.length(2);
      expect(outputtedTransactions).to.deep.include(tx1);
      expect(outputtedTransactions).to.deep.include(tx2);
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
      const transaction = await getMintOnlyOwnerTransaction(
        xerc20Chain2,
        ALICE,
        chain2MintAmount,
        ANVIL2_CHAIN_ID,
      );
      const transactions = [transaction];
      writeYamlOrJson(transactionsPath, transactions);

      await hyperlaneSubmit({ strategyPath, transactionsPath });
      const outputtedTransactions = readYamlOrJson(outputTransactionPath);
      expect(outputtedTransactions).to.deep.equal(transactions);
    });
  });

  describe('auto inference', function () {
    let mockSafeApiServer: Awaited<ReturnType<typeof createMockSafeApi>>;

    before(async function () {
      const owner = await xerc20Chain3.owner();
      const mockSafe = await new MockSafe__factory()
        .connect(xerc20Chain3.signer)
        .deploy([owner], 1);
      const safeAddress = mockSafe.address;

      await xerc20Chain3.transferOwnership(safeAddress);

      mockSafeApiServer = await createMockSafeApi(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        safeAddress,
        owner,
        5,
      );
    });

    after(async function () {
      await mockSafeApiServer.close();
    });

    it('should infer gnosisSafeTxBuilder without strategy file for safe-owned tx targets', async function () {
      const mintAmount = randomInt(1, 1000);
      const transactions = [
        await getMintOnlyOwnerTransaction(
          xerc20Chain3,
          BOB,
          mintAmount,
          ANVIL3_CHAIN_ID,
        ),
      ];
      const transactionsPath = `${TEMP_PATH}/strategy-test-transactions-safe-inference.yaml`;
      writeYamlOrJson(transactionsPath, transactions);

      const result = await hyperlaneSubmit({ transactionsPath });
      expect(result.text()).to.match(/-gnosisSafeTxBuilder-\d+-receipts\.json/);
    });

    it('should fall back to jsonRpc when target owner cannot be inferred', async function () {
      const recipient = randomAddress();
      const sender = await xerc20Chain2.signer.getAddress();
      const provider = xerc20Chain2.provider;

      const transactionsPath = `${TEMP_PATH}/strategy-test-transactions-jsonrpc-fallback.yaml`;
      writeYamlOrJson(transactionsPath, [
        {
          to: recipient,
          from: sender,
          value: '0x1',
          chainId: ANVIL2_CHAIN_ID,
        },
      ]);

      const initialBalance = await provider.getBalance(recipient);
      const result = await hyperlaneSubmit({ transactionsPath });

      expect(result.text()).to.match(/-jsonRpc-\d+-receipts\.json/);
      const finalBalance = await provider.getBalance(recipient);
      expect(finalBalance.sub(initialBalance)).to.eql(ethers.BigNumber.from(1));
    });
  });

  describe('explicit submitterOverrides', function () {
    it('should route same-chain transactions to override submitter by target', async function () {
      const signerAddress = await xerc20Chain2.owner();

      const mockSafe = await new MockSafe__factory()
        .connect(xerc20Chain2.signer)
        .deploy([signerAddress], 1);
      const safeAddress = mockSafe.address;

      const safeOwnedToken = await deployXERC20VSToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        9,
        'TOKEN.OVERRIDE',
      );
      await safeOwnedToken.transferOwnership(safeAddress);

      const strategyPath = `${TEMP_PATH}/submitter-overrides-strategy.yaml`;
      const strategyConfig = {
        [CHAIN_NAME_2]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME_2,
          },
          submitterOverrides: {
            [safeOwnedToken.address]: {
              type: TxSubmitterType.GNOSIS_TX_BUILDER,
              chain: CHAIN_NAME_2,
              safeAddress,
              version: '1.0',
            },
          },
        },
      };
      writeYamlOrJson(strategyPath, strategyConfig);

      const mintAmountDirect = randomInt(1, 1000);
      const mintAmountSafe = randomInt(1, 1000);
      const [txDirect, txSafeOwned] = await Promise.all([
        getMintOnlyOwnerTransaction(
          xerc20Chain2,
          ALICE,
          mintAmountDirect,
          ANVIL2_CHAIN_ID,
        ),
        getMintOnlyOwnerTransaction(
          safeOwnedToken,
          BOB,
          mintAmountSafe,
          ANVIL2_CHAIN_ID,
        ),
      ]);

      const transactionsPath = `${TEMP_PATH}/submitter-overrides-transactions.yaml`;
      writeYamlOrJson(transactionsPath, [txDirect, txSafeOwned]);

      const [initialAlice, initialBob] = await Promise.all([
        xerc20Chain2.balanceOf(ALICE),
        safeOwnedToken.balanceOf(BOB),
      ]);

      const result = await hyperlaneSubmit({ strategyPath, transactionsPath });
      const output = result.text();
      expect(output).to.match(/-jsonRpc-\d+-receipts\.json/);
      expect(output).to.match(/-gnosisSafeTxBuilder-\d+-receipts\.json/);

      const [finalAlice, finalBob] = await Promise.all([
        xerc20Chain2.balanceOf(ALICE),
        safeOwnedToken.balanceOf(BOB),
      ]);

      expect(finalAlice).to.eql(initialAlice.add(mintAmountDirect));
      // The Safe tx builder output is not executed onchain in this flow.
      expect(finalBob).to.eql(initialBob);
    });
  });
});
