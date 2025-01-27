import { compile } from '@ton/blueprint';
import { Cell, Dictionary, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { utils } from 'ethers';

import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';
import { OpCodes } from '../wrappers/utils/constants';

describe('MerkleTreeHook', () => {
  let code: Cell;

  beforeAll(async () => {
    code = await compile('MerkleTreeHook');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let merkleTreeHook: SandboxContract<MerkleTreeHook>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

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

  it('should insert with empty leaf', async () => {
    const leaves = ['anna', 'james', '', 'luke', 'erin'];
    for (let i = 0; i < leaves.length; i++) {
      let messageId = BigInt(utils.hashMessage(leaves[i]));
      const res = await merkleTreeHook.sendPostDispatch(
        deployer.getSender(),
        toNano('0.1'),
        {
          messageId,
          destDomain: 0,
          refundAddr: deployer.address,
          hookMetadata: {
            variant: 0,
            msgValue: toNano('0.1'),
            gasLimit: 50000n,
            refundAddress: deployer.address,
          },
        },
      );

      expect(res.transactions).toHaveTransaction({
        from: deployer.address,
        to: merkleTreeHook.address,
        op: OpCodes.POST_DISPATCH,
        success: true,
      });
      expect(res.externals).toHaveLength(1);
    }

    const root = await merkleTreeHook.getRoot();
    expect(root).toStrictEqual(
      0x1841827275d59b7515da81fb121637567b70ebd8b38ec5aadb51f4300976cba1n,
    );
  });

  it('should post dispatch', async () => {
    const leaves = [
      'bacon',
      'eye',
      'we',
      'ghost',
      'listen',
      'corn',
      'blonde',
      'gutter',
      'sanctuary',
      'seat',
      'generate',
      'twist',
      'waterfall',
      'monster',
      'elbow',
      'flash',
      'arrow',
      'moment',
      'cheat',
      'unity',
      'steak',
      'shelter',
      'camera',
      'album',
      'bread',
      'tease',
      'sentence',
      'tribe',
      'miserable',
      'ridge',
      'guerrilla',
      'inhabitant',
      'suspicion',
      'mosque',
      'printer',
      'land',
      'reliable',
      'circle',
      'first-hand',
      'time',
      'content',
      'management',
    ];

    for (let i = 0; i < leaves.length; i++) {
      let messageId = BigInt(utils.hashMessage(leaves[i]));
      const res = await merkleTreeHook.sendPostDispatch(
        deployer.getSender(),
        toNano('0.1'),
        {
          messageId,
          destDomain: 0,
          refundAddr: deployer.address,
          hookMetadata: {
            variant: 0,
            msgValue: toNano('0.1'),
            gasLimit: 50000n,
            refundAddress: deployer.address,
          },
        },
      );

      expect(res.transactions).toHaveTransaction({
        from: deployer.address,
        to: merkleTreeHook.address,
        op: OpCodes.POST_DISPATCH,
        success: true,
      });
      expect(res.externals).toHaveLength(1);
    }

    const treeRes = await merkleTreeHook.getTree();
    expect(treeRes.tree).toBeTruthy();
    expect(treeRes.count).toStrictEqual(leaves.length);

    const root = await merkleTreeHook.getRoot();
    expect(root).toStrictEqual(
      0x274d610098d8f109587e97c908cf549d129a14f5bad7eb10d36a427da97be6fcn,
    );
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
