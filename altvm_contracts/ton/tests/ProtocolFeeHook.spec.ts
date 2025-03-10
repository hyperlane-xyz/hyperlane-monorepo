import { compile } from '@ton/blueprint';
import { Cell, beginCell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';

import { ProtocolFeeHook } from '../wrappers/ProtocolFeeHook';
import { Errors, OpCodes } from '../wrappers/utils/constants';
import { HookMetadata, HypMessage } from '../wrappers/utils/types';

describe('ProtocolFeeHook', () => {
  let code: Cell;
  const maxProtocolFee = toNano(0.2);

  beforeAll(async () => {
    code = await compile('ProtocolFeeHook');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let owner: SandboxContract<TreasuryContract>;
  let protocolFeeHook: SandboxContract<ProtocolFeeHook>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    deployer = await blockchain.treasury('deployer');
    owner = await blockchain.treasury('owner');

    protocolFeeHook = blockchain.openContract(
      ProtocolFeeHook.createFromConfig(
        {
          protocolFee: 0n,
          maxProtocolFee,
          beneficiary: deployer.address,
          owner: deployer.address,
        },
        code,
      ),
    );

    const deployResult = await protocolFeeHook.sendDeploy(
      deployer.getSender(),
      toNano(1),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      deploy: true,
      success: true,
    });
  });

  it('should deploy', async () => {
    // the check is done inside beforeEach
    // blockchain and protocolFeeHook are ready to use
  });

  it('should send post dispatch', async () => {
    const result = await protocolFeeHook.sendPostDispatch(
      deployer.getSender(),
      toNano('0.1'),
      {
        message: new HypMessage().toCell(),
        hookMetadata: HookMetadata.fromObj({
          variant: 1,
          msgValue: toNano('0.1'),
          gasLimit: 50000n,
          refundAddress: deployer.address.hash,
        }).toCell(),
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: true,
    });

    expect(result.transactions).toHaveTransaction({
      from: protocolFeeHook.address,
      to: deployer.address,
      success: true,
    });
  });

  it('should collect protocol fee', async () => {
    const collectedFee = toNano(0.3);
    const beneficiary = await blockchain.treasury('beneficiary');
    const protocolFeeHook = blockchain.openContract(
      ProtocolFeeHook.createFromConfig(
        {
          protocolFee: toNano(0.01),
          maxProtocolFee,
          beneficiary: beneficiary.address,
          owner: deployer.address,
          collectedFee,
        },
        code,
      ),
    );

    const deployResult = await protocolFeeHook.sendDeploy(
      deployer.getSender(),
      toNano(1),
    );
    const balanceBefore = await protocolFeeHook.getBalance();
    expect(await protocolFeeHook.getCollectedFee()).toBe(collectedFee);

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      deploy: true,
      success: true,
    });

    const result = await protocolFeeHook.sendCollectProtocolFee(
      deployer.getSender(),
      toNano('0.01'),
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: true,
      op: OpCodes.COLLECT_PROTOCOL_FEE,
    });

    expect(result.transactions).toHaveTransaction({
      from: protocolFeeHook.address,
      to: beneficiary.address,
      success: true,
      value: collectedFee,
    });

    const balanceAfter = await protocolFeeHook.getBalance();
    expect(balanceBefore - balanceAfter).toBeLessThan(collectedFee);
    expect(await protocolFeeHook.getCollectedFee()).toBe(0n);
  });

  it('should set protocol fee', async () => {
    const newFee = 100n;
    const result = await protocolFeeHook.sendSetProtocolFee(
      deployer.getSender(),
      toNano('0.01'),
      {
        protocolFee: newFee,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: true,
    });

    const fee = await protocolFeeHook.getProtocolFee();
    expect(fee).toStrictEqual(newFee);
  });

  it('should transfer ownership', async () => {
    const result = await protocolFeeHook.sendTransferOwnership(
      deployer.getSender(),
      toNano('0.01'),
      {
        ownerAddr: owner.address,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: true,
    });
  });

  it('should throw if msg value is too low', async () => {
    await protocolFeeHook.sendSetProtocolFee(
      deployer.getSender(),
      toNano('0.01'),
      {
        protocolFee: toNano('0.02'),
      },
    );

    const result = await protocolFeeHook.sendPostDispatch(
      deployer.getSender(),
      toNano('0.01'),
      {
        message: new HypMessage().toCell(),
        hookMetadata: HookMetadata.fromObj({
          variant: 0,
          msgValue: toNano('0.01'),
          gasLimit: 50000n,
          refundAddress: deployer.address.hash,
        }).toCell(),
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: false,
      exitCode: Errors.MSG_VALUE_TOO_LOW,
    });
  });

  it('should throw if not owner on set protocol fee', async () => {
    const result = await protocolFeeHook.sendSetProtocolFee(
      owner.getSender(),
      toNano('0.01'),
      {
        protocolFee: 100n,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: protocolFeeHook.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if not owner on transfer ownership', async () => {
    const result = await protocolFeeHook.sendTransferOwnership(
      owner.getSender(),
      toNano('0.01'),
      {
        ownerAddr: owner.address,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: protocolFeeHook.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if not owner on set beneficiary', async () => {
    const result = await protocolFeeHook.sendSetBeneficiary(
      owner.getSender(),
      toNano('0.01'),
      {
        beneficiaryAddr: owner.address,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: protocolFeeHook.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if protocol fee too high', async () => {
    const result = await protocolFeeHook.sendSetProtocolFee(
      deployer.getSender(),
      toNano('0.01'),
      {
        protocolFee: maxProtocolFee + 1n,
      },
    );

    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: protocolFeeHook.address,
      success: false,
      exitCode: Errors.EXCEEDS_MAX_PROTOCOL_FEE,
    });
  });

  it('should get beneficiary', async () => {
    const beneficiary = await protocolFeeHook.getBeneficiary();
    expect(beneficiary.toString()).toStrictEqual(deployer.address.toString());
  });

  it('should get max protocol fee', async () => {
    const fee = await protocolFeeHook.getMaxProtocolFee();
    expect(fee).toStrictEqual(maxProtocolFee);
  });
});
