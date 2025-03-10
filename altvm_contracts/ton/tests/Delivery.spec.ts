import { compile } from '@ton/blueprint';
import { Cell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';

import { Delivery } from '../wrappers/Delivery';

import { makeRandomBigint } from './utils/generators';

describe('Delivery', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('Delivery');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let delivery: SandboxContract<Delivery>;

  let messageId: bigint;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    deployer = await blockchain.treasury('deployer');

    messageId = makeRandomBigint();

    delivery = blockchain.openContract(
      Delivery.createFromConfig(
        {
          messageId,
          mailboxAddress: deployer.address,
        },
        code,
      ),
    );

    const deployResult = await delivery.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
      Cell.EMPTY,
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: delivery.address,
      deploy: true,
      success: true,
    });
  });

  it('should deploy', async () => {
    const state = await delivery.getState();
    expect(state.initialized).toBe(true);
    expect(state.messageId).toBe(messageId);
    expect(state.mailboxAddress).toEqualAddress(deployer.address);
  });
});
