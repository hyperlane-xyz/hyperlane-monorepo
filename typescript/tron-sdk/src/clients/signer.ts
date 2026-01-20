import { assert } from 'chai';
import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import HypNativeAbi from '../abi/HypNative.json' with { type: 'json' };
import InterchainGasPaymasterAbi from '../abi/InterchainGasPaymaster.json' with { type: 'json' };
import GasOracleAbi from '../abi/StorageGasOracle.json' with { type: 'json' };
import StorageGasOracleAbi from '../abi/StorageGasOracle.json' with { type: 'json' };
import { getInitRoutingIsmTx } from '../ism/ism-tx.js';
import { TRON_EMPTY_ADDRESS } from '../utils/index.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

import { TronProvider } from './provider.js';

export class TronSigner
  extends TronProvider
  implements AltVM.ISigner<TronTransaction, TronReceipt>
{
  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<TronTransaction, TronReceipt>> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata as Record<string, unknown>;
    assert(metadata, `metadata not defined in extra params`);
    assert(metadata.chainId, `chainId not defined in metadata extra params`);

    const chainId = parseInt(metadata.chainId.toString());

    return new TronSigner(rpcUrls, chainId, privateKey);
  }

  protected constructor(
    rpcUrls: string[],
    chainId: string | number,
    privateKey: string,
  ) {
    super(rpcUrls, chainId, privateKey);
  }

  getSignerAddress(): string {
    return this.tronweb.defaultAddress.base58 || '';
  }

  getTronweb(): TronWeb {
    return this.tronweb;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: TronTransaction,
  ): Promise<object> {
    return transaction;
  }

  async sendAndConfirmTransaction(
    transaction: TronTransaction,
  ): Promise<TronReceipt> {
    const signedTx = await this.tronweb.trx.sign(transaction);
    const result = await this.tronweb.trx.sendRawTransaction(signedTx);
    const receipt = await this.waitForTransaction(result.txid);

    return receipt;
  }

  async sendAndConfirmBatchTransactions(
    _transactions: TronTransaction[],
  ): Promise<TronReceipt> {
    throw new Error(`${TronSigner.name} does not support transaction batching`);
  }

  // ### TX CORE ###

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    const tx = await this.getCreateMailboxTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const mailboxAddress = this.tronweb.address.fromHex(
      receipt.contract_address,
    );

    // TODO: TRON
    // include default hook and required hook in create mailbox altvm interface too
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        mailboxAddress,
        'initialize(address,address,address,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
          {
            type: 'address',
            value: mailboxAddress,
          },
          {
            type: 'address',
            value: mailboxAddress,
          },
          {
            type: 'address',
            value: mailboxAddress,
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(transaction);

    return {
      mailboxAddress,
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const tx = await this.getSetDefaultIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: req.ismAddress,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const tx = await this.getSetDefaultHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const tx = await this.getSetRequiredHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const tx = await this.getSetMailboxOwnerTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    const tx = await this.getCreateMerkleRootMultisigIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: this.tronweb.address.fromHex(receipt.contract_address),
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    const tx = await this.getCreateMessageIdMultisigIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: this.tronweb.address.fromHex(receipt.contract_address),
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const tx = await this.getCreateRoutingIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const ismAddress = this.tronweb.address.fromHex(receipt.contract_address);

    const initTx = await getInitRoutingIsmTx(
      this.tronweb,
      this.getSignerAddress(),
      {
        ismAddress,
        routes: req.routes,
      },
    );

    await this.sendAndConfirmTransaction(initTx);

    return {
      ismAddress,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const tx = await this.getSetRoutingIsmRouteTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      route: req.route,
    };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    const tx = await this.getRemoveRoutingIsmRouteTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      domainId: req.domainId,
    };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    const tx = await this.getSetRoutingIsmOwnerTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    const tx = await this.getCreateNoopIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: this.tronweb.address.fromHex(receipt.contract_address),
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const tx = await this.getCreateMerkleTreeHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: this.tronweb.address.fromHex(receipt.contract_address),
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    const tx = await this.getCreateInterchainGasPaymasterHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const hookAddress = this.tronweb.address.fromHex(receipt.contract_address);

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        hookAddress,
        'initialize(address,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(transaction);

    const oracleTx = await this.createDeploymentTransaction(
      StorageGasOracleAbi,
      this.getSignerAddress(),
      [],
    );

    const oracleReceipt = await this.sendAndConfirmTransaction(oracleTx);

    const oracleAddress = this.tronweb.address.fromHex(
      oracleReceipt.contract_address,
    );

    const { transaction: setOracleTx } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        hookAddress,
        'setGasOracle(address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: oracleAddress,
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(setOracleTx);

    return {
      hookAddress,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const tx = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    const tx = await this.getSetDestinationGasConfigTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    const igp = this.tronweb.contract(
      InterchainGasPaymasterAbi.abi,
      req.hookAddress,
    );

    const hookType = await igp.hookType().call();
    assert(
      Number(hookType) === 4,
      `hook type does not equal INTERCHAIN_GAS_PAYMASTER`,
    );

    const gasOracleAddress = this.tronweb.address.fromHex(
      await igp.gasOracle().call(),
    );

    const gasOracle = this.tronweb.contract(GasOracleAbi.abi, gasOracleAddress);

    await gasOracle
      .setRemoteGasData([
        BigInt(req.destinationGasConfig.remoteDomainId),
        BigInt(req.destinationGasConfig.gasOracle.tokenExchangeRate),
        BigInt(req.destinationGasConfig.gasOracle.gasPrice),
      ])
      .send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: true,
      });

    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async removeDestinationGasConfig(
    req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    const tx = await this.getRemoveDestinationGasConfigTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      remoteDomainId: req.remoteDomainId,
    };
  }

  async createNoopHook(
    req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    const tx = await this.getCreateNoopHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: this.tronweb.address.fromHex(receipt.contract_address),
    };
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    const tx = await this.getCreateValidatorAnnounceTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    return {
      validatorAnnounceId: this.tronweb.address.fromHex(
        receipt.contract_address,
      ),
    };
  }

  // ### TX WARP ###

  async createNativeToken(
    req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    const tx = await this.getCreateNativeTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const tokenAddress = this.tronweb.address.fromHex(receipt.contract_address);

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(address,address,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(transaction);

    return {
      tokenAddress,
    };
  }

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    const tx = await this.getCreateCollateralTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const tokenAddress = this.tronweb.address.fromHex(receipt.contract_address);

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(address,address,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(transaction);

    return {
      tokenAddress,
    };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    const tx = await this.getCreateSyntheticTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);

    const tokenAddress = this.tronweb.address.fromHex(receipt.contract_address);

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(uint256,string,string,address,address,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'uint256',
            value: 0,
          },
          {
            type: 'string',
            value: req.name,
          },
          {
            type: 'string',
            value: req.denom,
          },
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: TRON_EMPTY_ADDRESS,
          },
          {
            type: 'address',
            value: this.getSignerAddress(),
          },
        ],
        this.tronweb.address.toHex(this.getSignerAddress()),
      );

    await this.sendAndConfirmTransaction(transaction);

    return {
      tokenAddress,
    };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    const tx = await this.getSetTokenOwnerTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      newOwner: req.newOwner,
    };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    const tx = await this.getSetTokenIsmTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      ismAddress: req.ismAddress,
    };
  }

  async setTokenHook(
    req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    const tx = await this.getSetTokenHookTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      hookAddress: req.hookAddress,
    };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    const tx = await this.getEnrollRemoteRouterTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    const token = this.tronweb.contract(HypNativeAbi.abi, req.tokenAddress);

    await token
      .setDestinationGas(
        req.remoteRouter.receiverDomainId,
        req.remoteRouter.gas,
      )
      .send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: true,
      });

    return {
      receiverDomainId: req.remoteRouter.receiverDomainId,
    };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    const tx = await this.getUnenrollRemoteRouterTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      receiverDomainId: req.receiverDomainId,
    };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    const tx = await this.getTransferTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      recipient: req.recipient,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const tx = await this.getRemoteTransferTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    await this.sendAndConfirmTransaction(tx);

    return {
      tokenAddress: req.tokenAddress,
    };
  }
}
