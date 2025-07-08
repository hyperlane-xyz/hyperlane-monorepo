import { expect } from 'chai';
import { ethers } from 'ethers';

import { XERC20VSTest, XERC20VSTest__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType, randomAddress } from '@hyperlane-xyz/sdk';
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
  const USER = randomAddress();
  const ANVIL2_PORT = 31338;
  const ANVIL3_PORT = 31347;
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

    const transactions = await Promise.all([
      getMintOnlyOwnerTransaction(xerc20Chain2, USER, '1', ANVIL2_PORT),
      getMintOnlyOwnerTransaction(xerc20Chain3, USER, '1', ANVIL3_PORT),
    ]);
    const transactionsPath = `${TEMP_PATH}/strategy-test-transactions.yaml`;
    writeYamlOrJson(transactionsPath, transactions);

    // Get prior balances
    const [burnAddress2, burnAddress3] = await Promise.all([
      xerc20Chain2.balanceOf(USER),
      xerc20Chain3.balanceOf(USER),
    ]);
    expect(burnAddress2).to.eql(ethers.BigNumber.from(0));
    expect(burnAddress3).to.eql(ethers.BigNumber.from(0));

    await hyperlaneSubmit({ strategyPath, transactionsPath });

    // Check that the balances are now 1
    expect(burnAddress2).to.eql(ethers.BigNumber.from(1));
    expect(burnAddress3).to.eql(ethers.BigNumber.from(1));
  });

  it.only('should default to JSON RPC if no strategy is provided', function () {});
});
