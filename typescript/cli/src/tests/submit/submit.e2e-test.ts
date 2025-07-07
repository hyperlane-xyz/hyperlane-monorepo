import { ethers } from 'ethers';

import { XERC20VSTest, XERC20VSTest__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  TEMP_PATH,
  deployXERC20VSToken,
  hyperlaneSubmit,
} from '../commands/helpers.js';

async function getMintOnlyOwnerTransaction(
  xerc20: XERC20VSTest,
  address: Address,
  amount: string,
  chainId: number,
) {
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
describe.only('hyperlane submit', function () {
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
    const xerc20Chain2Owner = await xerc20Chain2.owner();
    const xerc20Chain3Owner = await xerc20Chain3.owner();
    const impersonateStrategy = {
      [CHAIN_NAME_2]: {
        submitter: {
          chain: CHAIN_NAME_2,
          type: TxSubmitterType.IMPERSONATED_ACCOUNT,
          userAddress: xerc20Chain2Owner,
        },
      },
      [CHAIN_NAME_3]: {
        submitter: {
          chain: CHAIN_NAME_3,
          type: TxSubmitterType.IMPERSONATED_ACCOUNT,
          userAddress: xerc20Chain3Owner,
        },
      },
    };

    const strategyPath = `${TEMP_PATH}/impersonate-account-chain-strategy.yaml`;
    writeYamlOrJson(strategyPath, impersonateStrategy);

    const transactions = await Promise.all([
      getMintOnlyOwnerTransaction(xerc20Chain2, xerc20Chain2Owner, '1', 31338),
      getMintOnlyOwnerTransaction(xerc20Chain3, xerc20Chain3Owner, '1', 31347),
    ]);
    const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
    writeYamlOrJson(transactionsPath, transactions);
    await hyperlaneSubmit({ strategyPath, transactionsPath });

    // Check that the balance is now 1
  });
  xit('should output receipts', function () {});
});
