import { compile } from '@ton/blueprint';
import {
  Cell,
  Dictionary,
  TransactionDescriptionGeneric,
  beginCell,
  toNano,
} from '@ton/core';
import {
  Blockchain,
  BlockchainSnapshot,
  SandboxContract,
  TreasuryContract,
} from '@ton/sandbox';
import '@ton/test-utils';

import { Delivery } from '../wrappers/Delivery';
import { InterchainGasPaymaster } from '../wrappers/InterchainGasPaymaster';
import {
  JettonMinterContract,
  buildTokenMetadataCell,
} from '../wrappers/JettonMinter';
import { JettonWalletContract } from '../wrappers/JettonWallet';
import { Mailbox } from '../wrappers/Mailbox';
import { MerkleHookMock } from '../wrappers/MerkleHookMock';
import { MockIsm } from '../wrappers/MockIsm';
import { TokenRouter } from '../wrappers/TokenRouter';
import {
  buildTokenMessage,
  multisigMetadataToCell,
} from '../wrappers/utils/builders';
import {
  Errors,
  METADATA_VARIANT,
  OpCodes,
  answer,
} from '../wrappers/utils/constants';
import {
  HookMetadata,
  HypMessage,
  TMailboxContractConfig,
  TMultisigMetadata,
} from '../wrappers/utils/types';

import { expectTransactionFlow } from './utils/expect';
import { makeRandomBigint } from './utils/generators';
import { messageId } from './utils/signing';

describe('TokenRouter', () => {
  let hypJettonCode: Cell;
  let hypNativeCode: Cell;
  let hypJettonCollateralCode: Cell;
  let mailboxCode: Cell;
  let requiredHookCode: Cell;
  let defaultHookCode: Cell;
  let mockIsmCode: Cell;
  let minterCode: Cell;
  let walletCode: Cell;
  const burnAmount = 10000000000n;
  const destinationChain = 1234;
  const originChain = 4321;

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let originRouterMock: SandboxContract<TreasuryContract>;
  let destRouterMock: SandboxContract<TreasuryContract>;
  let tokenRouter: SandboxContract<TokenRouter>;
  let mailbox: SandboxContract<Mailbox>;
  let recipient: SandboxContract<TreasuryContract>;
  let jettonMinter: SandboxContract<JettonMinterContract>;
  let jettonWallet: SandboxContract<JettonWalletContract>;
  let initialRequiredHook: SandboxContract<InterchainGasPaymaster>;
  let initialDefaultHook: SandboxContract<MerkleHookMock>;
  let initialDefaultIsm: SandboxContract<MockIsm>;
  let routers: Dictionary<number, Buffer>;
  const intialGasConfig = {
    gasOracle: makeRandomBigint(),
    gasOverhead: 0n,
    exchangeRate: 5n,
    gasPrice: 1000000000n,
  };
  const defaultHookConfig = {
    index: 0,
  };
  let snapshot: BlockchainSnapshot;

  beforeAll(async () => {
    hypJettonCode = await compile('HypJetton');
    hypNativeCode = await compile('HypNative');
    hypJettonCollateralCode = await compile('HypJettonCollateral');
    mailboxCode = await compile('Mailbox');
    requiredHookCode = await compile('InterchainGasPaymaster');
    defaultHookCode = await compile('MerkleHookMock');
    mockIsmCode = await compile('MockIsm');
    minterCode = await compile('JettonMinter');
    walletCode = await compile('JettonWallet');

    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    originRouterMock = await blockchain.treasury('originRouterMock');
    destRouterMock = await blockchain.treasury('destRouterMock');
    recipient = await blockchain.treasury('recipient');
    routers = Dictionary.empty(
      Dictionary.Keys.Uint(32),
      Dictionary.Values.Buffer(32),
    );
    routers.set(destinationChain, destRouterMock.address.hash);
    routers.set(originChain, originRouterMock.address.hash);

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
      MockIsm.createFromConfig({}, mockIsmCode),
    );

    const initConfig: TMailboxContractConfig = {
      version: Mailbox.version,
      localDomain: destinationChain,
      nonce: 0,
      latestDispatchedId: 0n,
      defaultIsm: initialDefaultIsm.address,
      defaultHookAddr: initialDefaultHook.address,
      requiredHookAddr: initialRequiredHook.address,
      owner: deployer.address,
      deliveryCode: await compile('Delivery'),
    };

    mailbox = blockchain.openContract(
      Mailbox.createFromConfig(initConfig, mailboxCode),
    );

    const jettonParams = {
      name: 'test jetton',
      symbol: 'test',
      decimals: '9',
    };

    jettonMinter = blockchain.openContract(
      JettonMinterContract.createFromConfig(
        {
          adminAddress: deployer.address,
          content: buildTokenMetadataCell(jettonParams),
          jettonWalletCode: walletCode,
        },
        minterCode,
      ),
    );

    const deployMboxRes = await mailbox.sendDeploy(
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

    const deployMinterRes = await jettonMinter.sendDeploy(
      deployer.getSender(),
      toNano('1.5'),
    );

    expect(deployMinterRes.transactions).toHaveTransaction({
      from: deployer.address,
      to: jettonMinter.address,
      deploy: true,
      success: true,
    });

    expect(deployMboxRes.transactions).toHaveTransaction({
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

    jettonWallet = blockchain.openContract(
      JettonWalletContract.createFromConfig(
        {
          ownerAddress: deployer.address,
          minterAddress: jettonMinter.address,
        },
        walletCode,
      ),
    );

    snapshot = blockchain.snapshot();
  });

  describe('hyp_jetton', () => {
    beforeEach(async () => {
      await blockchain.loadFrom(snapshot);

      tokenRouter = blockchain.openContract(
        TokenRouter.createFromConfig(
          {
            ownerAddress: deployer.address,
            mailboxAddress: mailbox.address,
            jettonAddress: jettonMinter.address,
            routers,
          },
          hypJettonCode,
        ),
      );

      await tokenRouter.sendDeploy(deployer.getSender(), toNano('0.05'));

      await jettonMinter.sendMint(deployer.getSender(), {
        toAddress: deployer.address,
        responseAddress: deployer.address,
        jettonAmount: burnAmount,
        queryId: 0,
        value: toNano(0.1),
      });

      await jettonMinter.sendUpdateAdmin(deployer.getSender(), {
        value: toNano(0.1),
        newAdminAddress: tokenRouter.address,
      });

      expect((await jettonMinter.getAdmin())?.toString()).toStrictEqual(
        tokenRouter.address.toString(),
      );

      //await blockchain.setVerbosityForAddress(mailbox.address,'vm_logs_full');
    });

    it('process -> handle (mint synthetic)', async () => {
      const { amount: balanceBefore } = await jettonWallet.getBalance();
      const mintedAmount = 1000n;
      const hyperlaneMessage = HypMessage.fromAny({
        origin: originChain,
        sender: originRouterMock.address.hash,
        destination: destinationChain,
        recipient: tokenRouter.address.hash,
        body: buildTokenMessage(deployer.address.hash, mintedAmount),
      });
      const metadata = multisigMetadataToCell({
        originMerkleHook: Buffer.alloc(32),
        root: Buffer.alloc(32),
        index: 0n,
        signatures: [{ r: 0n, s: 0n, v: 0n }],
      });
      const res = await mailbox.sendProcess(
        deployer.getSender(),
        toNano('0.1'),
        {
          metadata,
          message: hyperlaneMessage.toCell(),
        },
      );

      const delivery = Delivery.createFromConfig(
        {
          messageId: BigInt(messageId(hyperlaneMessage)),
          mailboxAddress: mailbox.address,
        },
        await compile('Delivery'),
      );

      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: mailbox.address,
          success: true,
          op: OpCodes.PROCESS,
        },
        {
          from: mailbox.address,
          to: tokenRouter.address,
          success: true,
          op: OpCodes.GET_ISM,
        },
        {
          from: tokenRouter.address,
          to: mailbox.address,
          success: true,
          op: answer(OpCodes.GET_ISM),
        },
        {
          from: mailbox.address,
          to: initialDefaultIsm.address,
          success: true,
          op: OpCodes.VERIFY,
        },
        {
          from: initialDefaultIsm.address,
          to: mailbox.address,
          success: true,
          op: answer(OpCodes.VERIFY),
        },
        {
          from: mailbox.address,
          to: delivery.address,
          success: true,
          op: OpCodes.DELIVERY_INITIALIZE,
        },
        {
          from: delivery.address,
          to: mailbox.address,
          success: true,
          op: answer(OpCodes.DELIVERY_INITIALIZE),
        },
        {
          from: mailbox.address,
          to: tokenRouter.address,
          success: true,
          op: OpCodes.HANDLE,
        },
        {
          from: tokenRouter.address,
          to: jettonMinter.address,
          success: true,
          op: OpCodes.JETTON_MINT,
        },
        {
          from: jettonMinter.address,
          to: jettonWallet.address,
          success: true,
          op: OpCodes.JETTON_INTERNAL_TRANSFER,
        },
        {
          from: jettonWallet.address,
          to: deployer.address,
          success: true,
          op: OpCodes.JETTON_EXCESSES,
        },
      ]);

      const { amount: balanceAfter } = await jettonWallet.getBalance();
      expect(balanceAfter - balanceBefore).toBe(mintedAmount);
    });

    it('burn synthetic -> dispatch', async () => {
      const refunder = await blockchain.treasury('refunder');
      const res = await jettonWallet.sendBurn(deployer.getSender(), {
        value: toNano(0.6),
        queryId: 0,
        jettonAmount: burnAmount,
        destDomain: destinationChain,
        recipientAddr: deployer.address.hash,
        hookMetadata: HookMetadata.fromObj({
          variant: METADATA_VARIANT.STANDARD,
          msgValue: toNano('1'),
          gasLimit: 100000000n,
          refundAddress: refunder.address.hash,
        }).toCell(),
      });
      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: jettonWallet.address,
          success: true,
          op: OpCodes.JETTON_BURN,
        },
        {
          from: jettonWallet.address,
          to: jettonMinter.address,
          success: true,
          op: OpCodes.JETTON_BURN_NOTIFICATION,
        },
        {
          from: jettonMinter.address,
          to: tokenRouter.address,
          success: true,
          op: OpCodes.JETTON_BURN_NOTIFICATION,
        },
        {
          from: tokenRouter.address,
          to: mailbox.address,
          success: true,
          op: OpCodes.DISPATCH,
        },
        {
          from: mailbox.address,
          to: initialRequiredHook.address,
          success: true,
          op: OpCodes.POST_DISPATCH,
        },
        {
          from: initialRequiredHook.address,
          to: mailbox.address,
          success: true,
          op: answer(OpCodes.POST_DISPATCH),
        },
        {
          from: mailbox.address,
          to: initialDefaultHook.address,
          success: true,
          op: OpCodes.POST_DISPATCH,
        },
        {
          from: initialDefaultHook.address,
          to: mailbox.address,
          success: true,
          op: answer(OpCodes.POST_DISPATCH),
        },
        {
          from: mailbox.address,
          to: refunder.address,
          success: true,
        },
      ]);
    });
  });

  describe('hyp_native', () => {
    let mailboxMock: SandboxContract<TreasuryContract>;
    let tokenRouterWithMailboxMock: SandboxContract<TokenRouter>;

    beforeEach(async () => {
      await blockchain.loadFrom(snapshot);
      mailboxMock = await blockchain.treasury('mailboxMock');

      tokenRouterWithMailboxMock = blockchain.openContract(
        TokenRouter.createFromConfig(
          {
            ownerAddress: deployer.address,
            mailboxAddress: mailboxMock.address,
            routers,
          },
          hypNativeCode,
        ),
      );

      await tokenRouterWithMailboxMock.sendDeploy(
        deployer.getSender(),
        toNano('0.05'),
      );

      tokenRouter = blockchain.openContract(
        TokenRouter.createFromConfig(
          {
            ownerAddress: deployer.address,
            mailboxAddress: mailbox.address,
            routers,
          },
          hypNativeCode,
        ),
      );

      await tokenRouter.sendDeploy(deployer.getSender(), toNano('0.05'));
    });

    it('native transfer -> dispatch', async () => {
      const amount = toNano(100);
      const executionFee = toNano(1);

      const res = await tokenRouter.sendTransferRemote(
        deployer.getSender(),
        amount + executionFee,
        {
          destination: destinationChain,
          recipient: deployer.address.hash,
          amount,
        },
      );

      const tx = res.transactions.find(
        (tx) =>
          tx.address.toString(16) === tokenRouter.address.hash.toString('hex'),
      );
      expect(tx).toBeDefined();
      const descr = tx!.description as TransactionDescriptionGeneric;
      const fwdFees = descr.actionPhase!.totalFwdFees!;
      const actionFees = descr.actionPhase!.totalActionFees!;
      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: tokenRouter.address,
          success: true,
          op: OpCodes.TRANSFER_REMOTE,
          value: amount + executionFee,
          body: beginCell()
            .storeUint(OpCodes.TRANSFER_REMOTE, 32)
            .storeUint(0, 64)
            .storeUint(destinationChain, 32)
            .storeBuffer(deployer.address.hash, 32)
            .storeUint(amount, 256)
            .storeMaybeRef(null)
            .storeMaybeRef(null)
            .endCell(),
        },
        {
          from: tokenRouter.address,
          to: mailbox.address,
          success: true,
          op: OpCodes.DISPATCH,
          value: executionFee - tx!.totalFees.coins - fwdFees + actionFees,
          body: beginCell()
            .storeUint(OpCodes.DISPATCH, 32)
            .storeUint(0, 64)
            .storeUint(destinationChain, 32)
            .storeBuffer(routers.get(destinationChain)!, 32)
            .storeRef(
              beginCell()
                .storeBuffer(deployer.address.hash)
                .storeUint(amount, 256)
                .endCell(),
            )
            .storeMaybeRef(
              HookMetadata.fromObj({
                variant: METADATA_VARIANT.STANDARD,
                msgValue: 0n,
                gasLimit: 0n,
                refundAddress: deployer.address.hash,
              }).toCell(),
            )
            .endCell(),
        },
      ]);
    });

    it('process -> handle (native transfer)', async () => {
      const amount = toNano(100);
      await deployer.send({
        value: amount,
        to: tokenRouterWithMailboxMock.address,
      });
      const balanceBefore = await recipient.getBalance();
      const routerBalance1 = await tokenRouterWithMailboxMock.getBalance();
      const res = await tokenRouterWithMailboxMock.sendHandle(
        mailboxMock.getSender(),
        toNano('0.1'),
        {
          queryId: 0n,
          origin: originChain,
          sender: routers.get(originChain)!,
          relayerAddress: deployer.address,
          messageBody: buildTokenMessage(recipient.address.hash, amount),
        },
      );
      const routerBalance2 = await tokenRouterWithMailboxMock.getBalance();
      const balanceAfter = await recipient.getBalance();
      expectTransactionFlow(res, [
        {
          from: mailboxMock.address,
          to: tokenRouterWithMailboxMock.address,
          success: true,
          op: OpCodes.HANDLE,
        },
        {
          from: tokenRouterWithMailboxMock.address,
          to: recipient.address,
          success: true,
          body: beginCell().endCell(),
          op: undefined,
          value: amount,
        },
        {
          from: tokenRouterWithMailboxMock.address,
          to: deployer.address,
          success: true,
          op: answer(OpCodes.HANDLE),
        },
      ]);
      const tx = res.transactions.find(
        (tx) =>
          tx.address.toString(16) === recipient.address.hash.toString('hex'),
      );
      expect(balanceAfter - balanceBefore).toBe(amount - tx!.totalFees.coins);
      expect(routerBalance1 - routerBalance2).toBe(amount);
    });

    it('process -> handle (not a mailbox)', async () => {
      const amount = toNano(100);
      const res = await tokenRouterWithMailboxMock.sendHandle(
        deployer.getSender(),
        toNano('0.1'),
        {
          queryId: 0n,
          origin: originChain,
          sender: routers.get(originChain)!,
          relayerAddress: deployer.address,
          messageBody: buildTokenMessage(recipient.address.hash, amount),
        },
      );

      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: tokenRouterWithMailboxMock.address,
          success: false,
          op: OpCodes.HANDLE,
          exitCode: Errors.UNAUTHORIZED_SENDER,
        },
      ]);
    });
  });

  describe('hyp_jetton_collateral', () => {
    const amount = toNano(1000);
    beforeEach(async () => {
      await blockchain.loadFrom(snapshot);
      tokenRouter = blockchain.openContract(
        TokenRouter.createFromConfig(
          {
            jettonAddress: jettonMinter.address,
            ownerAddress: deployer.address,
            mailboxAddress: mailbox.address,
            routers,
          },
          hypJettonCollateralCode,
        ),
      );

      await tokenRouter.sendDeploy(deployer.getSender(), toNano('0.05'));

      await jettonMinter.sendMint(deployer.getSender(), {
        toAddress: deployer.address,
        responseAddress: deployer.address,
        jettonAmount: amount,
        queryId: 0,
        value: toNano(0.1),
      });
    });

    it('transfer token -> dispatch', async () => {
      const refundAddress = await blockchain.treasury('refundAddress');
      const res = await jettonWallet.sendTransfer(deployer.getSender(), {
        value: toNano(1.1),
        toAddress: tokenRouter.address,
        queryId: 0,
        jettonAmount: amount,
        notify: {
          value: toNano(1),
          payload: beginCell()
            .storeUint(originChain, 32)
            .storeBuffer(recipient.address.hash, 32)
            .storeMaybeRef(
              HookMetadata.fromObj({
                variant: METADATA_VARIANT.STANDARD,
                msgValue: 0n,
                gasLimit: 1000000000n,
                refundAddress: refundAddress.address.hash,
              }).toCell(),
            )
            .storeMaybeRef(null)
            .endCell(),
        },
      });

      const tokenRouterWallet = blockchain.openContract(
        JettonWalletContract.createFromAddress(
          await jettonMinter.getWalletAddress(tokenRouter.address),
        ),
      );

      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: jettonWallet.address,
          success: true,
          op: OpCodes.JETTON_TRANSFER,
        },
        {
          from: jettonWallet.address,
          to: tokenRouterWallet.address,
          success: true,
          op: OpCodes.JETTON_INTERNAL_TRANSFER,
        },
        {
          from: tokenRouterWallet.address,
          to: tokenRouter.address,
          success: true,
          op: OpCodes.JETTON_TRANSFER_NOTIFICATION,
        },
      ]);
    });

    it.todo('process -> handle (transfer token)');
  });

  describe('Routers map', () => {
    beforeEach(async () => {
      await blockchain.loadFrom(snapshot);

      tokenRouter = blockchain.openContract(
        TokenRouter.createFromConfig(
          {
            ownerAddress: deployer.address,
            mailboxAddress: mailbox.address,
            routers: Dictionary.empty(
              Dictionary.Keys.Uint(32),
              Dictionary.Values.Buffer(32),
            ),
          },
          hypJettonCode,
        ),
      );

      await tokenRouter.sendDeploy(deployer.getSender(), toNano(0.1));
    });

    it('set router', async () => {
      const res = await tokenRouter.sendSetRouter(
        deployer.getSender(),
        toNano(0.1),
        {
          domain: 1,
          router: originRouterMock.address.hash,
        },
      );
      expectTransactionFlow(res, [
        {
          from: deployer.address,
          to: tokenRouter.address,
          success: true,
        },
      ]);

      const dictRouters = await tokenRouter.getRouters();
      expect(dictRouters.get(1)).toBeDefined();
      expect(dictRouters.get(1)!.toString('hex')).toBe(
        originRouterMock.address.hash.toString('hex'),
      );
    });
  });
});
