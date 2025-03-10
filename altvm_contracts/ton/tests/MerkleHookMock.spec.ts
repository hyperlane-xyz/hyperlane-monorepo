import { compile } from '@ton/blueprint';
import { Cell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';

import { MerkleHookMock } from '../wrappers/MerkleHookMock';
import { OpCodes } from '../wrappers/utils/constants';
import { HookMetadata, HypMessage } from '../wrappers/utils/types';

describe('MerkleHookMock', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('MerkleHookMock');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let merkleHookMock: SandboxContract<MerkleHookMock>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    merkleHookMock = blockchain.openContract(
      MerkleHookMock.createFromConfig(
        {
          index: 0,
        },
        code,
      ),
    );

    deployer = await blockchain.treasury('deployer');

    const deployResult = await merkleHookMock.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: merkleHookMock.address,
      deploy: true,
      success: true,
    });
  });

  it('should deploy', async () => {
    // the check is done inside beforeEach
    // blockchain and merkleHookMock are ready to use
  });

  it('should post dispatch', async () => {
    const res = await merkleHookMock.sendPostDispatch(
      deployer.getSender(),
      toNano('0.1'),
      {
        message: new HypMessage()
          .overrideRecipient(deployer.address.hash)
          .toCell(),
        hookMetadata: new HookMetadata()
          .overrideRefundAddr(deployer.address.hash)
          .toCell(),
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: merkleHookMock.address,
      op: OpCodes.POST_DISPATCH,
      success: true,
    });
    expect(res.externals).toHaveLength(1);
    const count = await merkleHookMock.getCount();
    expect(count).toStrictEqual(2);
    const latestCheckpoint = await merkleHookMock.getLatestCheckpoint();
    expect(latestCheckpoint).toStrictEqual({ root: 0, index: 1 });
  });
});
