import { compile } from '@ton/blueprint';
import { Cell, Dictionary, beginCell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';

import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';
import { OpCodes, answer } from '../wrappers/utils/constants';
import { HookMetadata, HypMessage } from '../wrappers/utils/types';

describe('MerkleTreeHook', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('MerkleTreeHook');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let merkleTreeHook: SandboxContract<MerkleTreeHook>;
  let mailbox: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    mailbox = await blockchain.treasury('mailbox');

    const dict = Dictionary.empty(
      Dictionary.Keys.Uint(8),
      Dictionary.Values.BigUint(256),
    );
    for (let i = 0; i < 32; i++) {
      dict.set(i, 0n);
    }
    merkleTreeHook = blockchain.openContract(
      MerkleTreeHook.createFromConfig(
        {
          index: 0,
          tree: dict,
          mailboxAddr: mailbox.address,
        },
        code,
      ),
    );

    deployer = await blockchain.treasury('deployer');

    const deployResult = await merkleTreeHook.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: merkleTreeHook.address,
      deploy: true,
      success: true,
    });
  });

  it('should post dispatch', async () => {
    const res = await merkleTreeHook.sendPostDispatch(
      deployer.getSender(),
      toNano('0.1'),
      {
        message: new HypMessage()
          .overrideOrigin(1)
          .overrideDest(0)
          .overrideRecipient(deployer.address.hash)
          .toCell(),
        hookMetadata: HookMetadata.fromObj({
          variant: 0,
          msgValue: toNano('0.1'),
          gasLimit: 50000n,
          refundAddress: deployer.address.hash,
        }).toCell(),
      },
    );

    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: merkleTreeHook.address,
      op: OpCodes.POST_DISPATCH,
      success: true,
    });
    expect(res.externals).toHaveLength(1);
    expect(res.transactions).toHaveTransaction({
      from: merkleTreeHook.address,
      to: deployer.address,
      success: true,
      op: answer(OpCodes.POST_DISPATCH),
    });
  });

  it('should return root', async () => {
    const res = await merkleTreeHook.getRoot();
    expect(res).toStrictEqual(
      0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757n,
    );
  });

  it('should return root and count', async () => {
    const res = await merkleTreeHook.getTree();
    expect(res.tree).toBeTruthy();
    expect(res.count).toStrictEqual(0);
  });
});
