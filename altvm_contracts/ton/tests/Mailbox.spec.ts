import { compile } from '@ton/blueprint';
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core';
import {
  Blockchain,
  BlockchainTransaction,
  SandboxContract,
  TreasuryContract,
} from '@ton/sandbox';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { ethers } from 'ethers';

import { InterchainGasPaymaster } from '../wrappers/InterchainGasPaymaster';
import { Mailbox } from '../wrappers/Mailbox';
import { MerkleHookMock } from '../wrappers/MerkleHookMock';
import { MockIsm } from '../wrappers/MockIsm';
import { RecipientMock } from '../wrappers/RecipientMock';
import { Errors, OpCodes, ProcessOpCodes } from '../wrappers/utils/constants';
import {
  THookMetadata,
  TMailboxContractConfig,
  TMessage,
  TMultisigMetadata,
} from '../wrappers/utils/types';

import { makeRandomBigint } from './utils/generators';
import { parseHandleLog } from './utils/parsers';
import { messageId } from './utils/signing';

const buildMessage = (
  recipient: Buffer,
  sender: Buffer,
  version: number = 1,
  destinationDomain: number = 0,
) => {
  return {
    version,
    nonce: 0,
    origin: 0,
    sender: sender,
    destinationDomain,
    recipient: recipient,
    body: beginCell().storeUint(123, 32).endCell(),
  };
};

const expectHandleLog = (
  externals: BlockchainTransaction[],
  message: TMessage,
  src: Address,
) => {
  expect(externals).toHaveLength(1);
  expect(externals[0].externals[0].info.src.toString()).toStrictEqual(
    src.toString(),
  );
  const logBody = externals[0].externals[0].body;
  const { origin, sender, body } = parseHandleLog(logBody);
  expect(origin).toStrictEqual(message.origin);
  expect(sender).toStrictEqual(message.sender);
  expect(body.toBoc()).toStrictEqual(message.body.toBoc());
};

describe('Mailbox', () => {
  let code: Cell;
  let requiredHookCode: Cell;
  let defaultHookCode: Cell;
  let defaultIsmCode: Cell;
  let recipientCode: Cell;

  let hyperlaneMessage: TMessage;
  let hookMetadata: THookMetadata;
  let dispatchBody: {
    destDomain: number;
    recipientAddr: Buffer;
    requiredValue: bigint;
    message: Cell;
    hookMetadata: THookMetadata;
    queryId?: number | undefined;
  };

  beforeAll(async () => {
    code = await compile('Mailbox');
    requiredHookCode = await compile('InterchainGasPaymaster');
    defaultHookCode = await compile('MerkleHookMock');
    defaultIsmCode = await compile('MockIsm');
    recipientCode = await compile('RecipientMock');
  });

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let fraud: SandboxContract<TreasuryContract>;
  let mailbox: SandboxContract<Mailbox>;
  let initialRequiredHook: SandboxContract<InterchainGasPaymaster>;
  let initialDefaultHook: SandboxContract<MerkleHookMock>;
  let initialDefaultIsm: SandboxContract<MockIsm>;
  let recipient: SandboxContract<RecipientMock>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    fraud = await blockchain.treasury('fraud');

    const intialGasConfig = {
      gasOracle: makeRandomBigint(),
      gasOverhead: 0n,
      exchangeRate: 5n,
      gasPrice: 1000000000n,
    };

    const dictDestGasConfig = Dictionary.empty(
      InterchainGasPaymaster.GasConfigKey,
      InterchainGasPaymaster.GasConfigValue,
    );
    dictDestGasConfig.set(0, intialGasConfig);

    const requiredHookConfig = {
      owner: deployer.address,
      beneficiary: deployer.address,
      hookType: 0,
      hookMetadata: Cell.EMPTY,
      destGasConfig: dictDestGasConfig,
    };

    const defaultHookConfig = {
      index: 0,
    };

    initialRequiredHook = blockchain.openContract(
      InterchainGasPaymaster.createFromConfig(
        requiredHookConfig,
        requiredHookCode,
      ),
    );
    initialDefaultHook = blockchain.openContract(
      MerkleHookMock.createFromConfig(defaultHookConfig, defaultHookCode),
    );
    initialDefaultIsm = blockchain.openContract(
      MockIsm.createFromConfig({}, defaultIsmCode),
    );
    recipient = blockchain.openContract(
      RecipientMock.createFromConfig(
        {
          ismAddr: initialDefaultIsm.address,
        },
        recipientCode,
      ),
    );

    const initConfig: TMailboxContractConfig = {
      version: 1,
      localDomain: 0,
      nonce: 0,
      latestDispatchedId: 0n,
      defaultIsm: initialDefaultIsm.address,
      defaultHookAddr: initialDefaultHook.address,
      requiredHookAddr: initialRequiredHook.address,
      owner: deployer.address,
      deliveries: Dictionary.empty(Mailbox.DeliveryKey, Mailbox.DeliveryValue),
    };
    mailbox = blockchain.openContract(
      Mailbox.createFromConfig(initConfig, code),
    );

    const deployResult = await mailbox.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );
    const deployRecipientRes = await recipient.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );
    const deployIsmRes = await initialDefaultIsm.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );
    const deployIgpRes = await initialRequiredHook.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );
    const deployDefaultHookRes = await initialDefaultHook.sendDeploy(
      deployer.getSender(),
      toNano('0.05'),
    );

    expect(deployResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      deploy: true,
      success: true,
    });

    expect(deployIgpRes.transactions).toHaveTransaction({
      from: deployer.address,
      to: initialRequiredHook.address,
      deploy: true,
      success: true,
    });

    expect(deployIsmRes.transactions).toHaveTransaction({
      from: deployer.address,
      to: initialDefaultIsm.address,
      deploy: true,
      success: true,
    });

    expect(deployDefaultHookRes.transactions).toHaveTransaction({
      from: deployer.address,
      to: initialDefaultHook.address,
      deploy: true,
      success: true,
    });

    expect(deployRecipientRes.transactions).toHaveTransaction({
      from: deployer.address,
      to: recipient.address,
      deploy: true,
      success: true,
    });

    hyperlaneMessage = buildMessage(recipient.address.hash, Buffer.alloc(32));
    hookMetadata = {
      variant: 0,
      msgValue: toNano('1'),
      gasLimit: 100000000n,
      refundAddress: deployer.address,
    };
  });

  it('should dispatch message and send log message', async () => {
    const ethersWallet = ethers.Wallet.createRandom();
    const addr = Buffer.from(
      ethersWallet.address.slice(2).padStart(64, '0'),
      'hex',
    );
    hyperlaneMessage = buildMessage(addr, deployer.address.hash);
    const requiredValue = await initialRequiredHook.getQuoteDispatch(
      0,
      hookMetadata,
    );
    const id = messageId(hyperlaneMessage);
    dispatchBody = {
      destDomain: 0,
      recipientAddr: addr,
      requiredValue: requiredValue,
      message: beginCell().storeUint(123, 32).endCell(),
      hookMetadata,
    };
    const res = await mailbox.sendDispatch(
      deployer.getSender(),
      toNano('1'),
      dispatchBody,
    );
    expect(res.transactions).toHaveTransaction({
      from: mailbox.address,
      to: initialRequiredHook.address,
      success: true,
      op: OpCodes.POST_DISPATCH,
    });

    expect(res.transactions).toHaveTransaction({
      from: mailbox.address,
      to: initialDefaultHook.address,
      success: true,
      op: OpCodes.POST_DISPATCH,
    });

    expect(res.externals).toHaveLength(3);
    expect(res.externals[0].info.src.toString()).toStrictEqual(
      mailbox.address.toString(),
    );
    expect(res.externals[1].info.src.toString()).toStrictEqual(
      initialRequiredHook.address.toString(),
    );
    expect(res.externals[2].info.src.toString()).toStrictEqual(
      initialDefaultHook.address.toString(),
    );

    const logBody = res.externals[0].body;
    expect(logBody.beginParse().loadUintBig(256)).toStrictEqual(BigInt(id));
  });

  it('should process incoming message', async () => {
    const metadata: TMultisigMetadata = {
      originMerkleHook: Buffer.alloc(32),
      root: Buffer.alloc(32),
      index: 0n,
      signatures: [{ r: 0n, s: 0n, v: 0n }],
    };
    const res = await mailbox.sendProcess(deployer.getSender(), toNano('0.1'), {
      blockNumber: 0,
      metadata,
      message: hyperlaneMessage,
    });
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      success: true,
    });
    expect(res.transactions).toHaveTransaction({
      from: mailbox.address,
      to: recipient.address,
      success: true,
      op: OpCodes.GET_ISM,
    });
    expect(res.transactions).toHaveTransaction({
      from: recipient.address,
      to: mailbox.address,
      success: true,
      op: OpCodes.PROCESS,
    });
    expect(res.transactions).toHaveTransaction({
      from: mailbox.address,
      to: initialDefaultIsm.address,
      success: true,
      op: OpCodes.VERIFY,
    });
    expect(res.transactions).toHaveTransaction({
      from: initialDefaultIsm.address,
      to: mailbox.address,
      success: true,
      op: OpCodes.PROCESS,
    });
    expect(res.transactions).toHaveTransaction({
      from: mailbox.address,
      to: recipient.address,
      success: true,
      op: OpCodes.HANDLE,
    });
    const externals = res.transactions.filter((transaction: any) => {
      return transaction.externals.length === 1;
    });

    expectHandleLog(externals, hyperlaneMessage, recipient.address);
  });

  it('should set default ism', async () => {
    const newAddr = randomAddress();
    await mailbox.sendSetDefaultIsm(deployer.getSender(), toNano('1'), {
      defaultIsmAddr: newAddr,
    });
    const defaultIsm = await mailbox.getDefaultIsm();
    expect(defaultIsm.toString()).toStrictEqual(newAddr.toString());
  });

  it('should set default hook', async () => {
    const newAddr = randomAddress();
    await mailbox.sendSetDefaultHook(deployer.getSender(), toNano('1'), {
      defaultHookAddr: newAddr,
    });
    const defaultHook = await mailbox.getDefaultHook();
    expect(defaultHook.toString()).toStrictEqual(newAddr.toString());
  });

  it('should set required hook', async () => {
    const newAddr = randomAddress();
    await mailbox.sendSetRequiredHook(deployer.getSender(), toNano('1'), {
      requiredHookAddr: newAddr,
    });
    const requiredHook = await mailbox.getRequiredHook();
    expect(requiredHook.toString()).toStrictEqual(newAddr.toString());
  });

  it('should throw if sender not owner on setting ism', async () => {
    const newAddr = randomAddress();
    const res = await mailbox.sendSetDefaultIsm(
      fraud.getSender(),
      toNano('1'),
      { defaultIsmAddr: newAddr },
    );
    expect(res.transactions).toHaveTransaction({
      from: fraud.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if sender not owner on setting hook', async () => {
    const newAddr = randomAddress();
    const res = await mailbox.sendSetDefaultHook(
      fraud.getSender(),
      toNano('1'),
      { defaultHookAddr: newAddr },
    );
    expect(res.transactions).toHaveTransaction({
      from: fraud.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if sender not owner on setting required hook', async () => {
    const newAddr = randomAddress();
    const res = await mailbox.sendSetRequiredHook(
      fraud.getSender(),
      toNano('1'),
      { requiredHookAddr: newAddr },
    );
    expect(res.transactions).toHaveTransaction({
      from: fraud.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if wrong mailbox version', async () => {
    hyperlaneMessage = buildMessage(
      recipient.address.hash,
      Buffer.alloc(32),
      2,
    );
    const res = await mailbox.sendProcess(deployer.getSender(), toNano('0.1'), {
      blockNumber: 0,
      metadata: {
        originMerkleHook: Buffer.alloc(32),
        root: Buffer.alloc(32),
        index: 0n,
        signatures: [{ r: 0n, s: 0n, v: 0n }],
      },
      message: hyperlaneMessage,
    });
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.WRONG_MAILBOX_VERSION,
    });
  });

  it('should throw if wrong dest domain', async () => {
    hyperlaneMessage = buildMessage(
      recipient.address.hash,
      Buffer.alloc(32),
      1,
      1,
    );
    const res = await mailbox.sendProcess(deployer.getSender(), toNano('0.1'), {
      blockNumber: 0,
      metadata: {
        originMerkleHook: Buffer.alloc(32),
        root: Buffer.alloc(32),
        index: 0n,
        signatures: [{ r: 0n, s: 0n, v: 0n }],
      },
      message: hyperlaneMessage,
    });
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.WRONG_DEST_DOMAIN,
    });
  });

  it('should throw if wrong sender on verify', async () => {
    const res = await mailbox.sendProcessWSubOp(
      deployer.getSender(),
      toNano('0.1'),
      {
        subOp: ProcessOpCodes.VERIFY,
        metadata: {
          originMerkleHook: Buffer.alloc(32),
          root: Buffer.alloc(32),
          index: 0n,
          signatures: [{ r: 0n, s: 0n, v: 0n }],
        },
        message: hyperlaneMessage,
      },
    );
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should throw if wrong sender on deliver message', async () => {
    const res = await mailbox.sendProcessWSubOp(
      deployer.getSender(),
      toNano('0.1'),
      {
        subOp: ProcessOpCodes.DELIVER_MESSAGE,
        metadata: {
          originMerkleHook: Buffer.alloc(32),
          root: Buffer.alloc(32),
          index: 0n,
          signatures: [{ r: 0n, s: 0n, v: 0n }],
        },
        message: hyperlaneMessage,
      },
    );
    expect(res.transactions).toHaveTransaction({
      from: deployer.address,
      to: mailbox.address,
      success: false,
      exitCode: Errors.UNAUTHORIZED_SENDER,
    });
  });

  it('should return default ism address', async () => {
    const defaultIsmAddr = await mailbox.getDefaultIsm();
    expect(defaultIsmAddr.toString()).toStrictEqual(
      initialDefaultIsm.address.toString(),
    );
  });

  it('should return default hook address', async () => {
    const defaultHookAddr = await mailbox.getDefaultHook();
    expect(defaultHookAddr.toString()).toStrictEqual(
      initialDefaultHook.address.toString(),
    );
  });

  it('should return required hook address', async () => {
    const requiredHookAddr = await mailbox.getRequiredHook();
    expect(requiredHookAddr.toString()).toStrictEqual(
      initialRequiredHook.address.toString(),
    );
  });

  it('should return local domain', async () => {
    const localDomain = await mailbox.getLocalDomain();
    expect(localDomain).toStrictEqual(0);
  });

  it('should return latest dispatched id', async () => {
    const latestDispatchedId = await mailbox.getLatestDispatchedId();
    expect(latestDispatchedId).toStrictEqual(0);
  });

  it('should return deliveries', async () => {
    const deliveries = await mailbox.getDeliveries();
    expect(deliveries).toStrictEqual(
      Dictionary.empty(Mailbox.DeliveryKey, Mailbox.DeliveryValue),
    );
  });
});
