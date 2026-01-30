import { assert } from 'chai';
import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import HypNativeAbi from '../abi/HypNative.json' with { type: 'json' };
import TransparentUpgradeableProxyAbi from '../abi/TransparentUpgradeableProxy.json' with { type: 'json' };
import {
  getCreateOracleTx,
  getInitIgpTx,
  getSetOracleTx,
  getSetRemoteGasTx,
} from '../hook/hook-tx.js';
import { getInitRoutingIsmTx } from '../ism/ism-tx.js';
import {
  TRON_EMPTY_ADDRESS,
  createDeploymentTransaction,
} from '../utils/index.js';
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

    return new TronSigner(rpcUrls, privateKey);
  }

  protected constructor(rpcUrls: string[], privateKey: string) {
    super(rpcUrls, privateKey);
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
    // Tron always uses proxy deployment - proxyAdminAddress must be provided
    if (!req.proxyAdminAddress) {
      throw new Error(
        'proxyAdminAddress is required for Tron mailbox deployment',
      );
    }

    // 1. Deploy Mailbox implementation
    const implTx = await this.getCreateMailboxTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });
    const implReceipt = await this.sendAndConfirmTransaction(implTx);
    const implementationAddress = this.tronweb.address.fromHex(
      implReceipt.contract_address,
    );

    // 2. Deploy TransparentUpgradeableProxy
    // Note: We pass empty bytes for _data and initialize separately below
    const proxyTx = await createDeploymentTransaction(
      this.tronweb,
      TransparentUpgradeableProxyAbi,
      this.getSignerAddress(),
      [implementationAddress, req.proxyAdminAddress, '0x'],
    );
    const proxyReceipt = await this.sendAndConfirmTransaction(proxyTx);
    const mailboxAddress = this.tronweb.address.fromHex(
      proxyReceipt.contract_address,
    );

    // 3. Initialize the Mailbox through the proxy
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        mailboxAddress,
        'initialize(address,address,address,address)',
        {
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

    const initTx = await getInitIgpTx(this.tronweb, this.getSignerAddress(), {
      igpAddress: hookAddress,
    });

    await this.sendAndConfirmTransaction(initTx);

    const oracleTx = await getCreateOracleTx(
      this.tronweb,
      this.getSignerAddress(),
    );

    const oracleReceipt = await this.sendAndConfirmTransaction(oracleTx);

    const oracleAddress = this.tronweb.address.fromHex(
      oracleReceipt.contract_address,
    );

    const setOracleTx = await getSetOracleTx(
      this.tronweb,
      this.getSignerAddress(),
      {
        igpAddress: hookAddress,
        oracleAddress,
      },
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

    const setGasTx = await getSetRemoteGasTx(
      this.tronweb,
      this.getSignerAddress(),
      {
        igpAddress: req.hookAddress,
        destinationGasConfigs: [
          {
            remoteDomainId: req.destinationGasConfig.remoteDomainId,
            gasOracle: {
              tokenExchangeRate:
                req.destinationGasConfig.gasOracle.tokenExchangeRate,
              gasPrice: req.destinationGasConfig.gasOracle.gasPrice,
            },
          },
        ],
      },
    );

    await this.sendAndConfirmTransaction(setGasTx);

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

  async createProxyAdmin(
    req: Omit<AltVM.ReqCreateProxyAdmin, 'signer'>,
  ): Promise<AltVM.ResCreateProxyAdmin> {
    const tx = await this.getCreateProxyAdminTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });

    const receipt = await this.sendAndConfirmTransaction(tx);
    const proxyAdminAddress = this.tronweb.address.fromHex(
      receipt.contract_address,
    );

    // Transfer ownership if owner is provided and different from signer
    if (req.owner && req.owner !== this.getSignerAddress()) {
      const { transaction } =
        await this.tronweb.transactionBuilder.triggerSmartContract(
          proxyAdminAddress,
          'transferOwnership(address)',
          {
            callValue: 0,
          },
          [
            {
              type: 'address',
              value: req.owner,
            },
          ],
          this.tronweb.address.toHex(this.getSignerAddress()),
        );

      await this.sendAndConfirmTransaction(transaction);
    }

    return {
      proxyAdminAddress,
    };
  }

  // ### TX WARP ###

  async createNativeToken(
    req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    // Tron always uses proxy deployment - proxyAdminAddress must be provided
    if (!req.proxyAdminAddress) {
      throw new Error(
        'proxyAdminAddress is required for Tron native token deployment',
      );
    }

    // 1. Deploy token implementation
    const implTx = await this.getCreateNativeTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });
    const implReceipt = await this.sendAndConfirmTransaction(implTx);
    const implementationAddress = this.tronweb.address.fromHex(
      implReceipt.contract_address,
    );

    // 2. Deploy TransparentUpgradeableProxy
    const proxyTx = await createDeploymentTransaction(
      this.tronweb,
      TransparentUpgradeableProxyAbi,
      this.getSignerAddress(),
      [implementationAddress, req.proxyAdminAddress, '0x'],
    );
    const proxyReceipt = await this.sendAndConfirmTransaction(proxyTx);
    const tokenAddress = this.tronweb.address.fromHex(
      proxyReceipt.contract_address,
    );

    // 3. Initialize the token through the proxy
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(address,address,address)',
        {
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
    // Tron always uses proxy deployment - proxyAdminAddress must be provided
    if (!req.proxyAdminAddress) {
      throw new Error(
        'proxyAdminAddress is required for Tron collateral token deployment',
      );
    }

    // 1. Deploy token implementation
    const implTx = await this.getCreateCollateralTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });
    const implReceipt = await this.sendAndConfirmTransaction(implTx);
    const implementationAddress = this.tronweb.address.fromHex(
      implReceipt.contract_address,
    );

    // 2. Deploy TransparentUpgradeableProxy
    const proxyTx = await createDeploymentTransaction(
      this.tronweb,
      TransparentUpgradeableProxyAbi,
      this.getSignerAddress(),
      [implementationAddress, req.proxyAdminAddress, '0x'],
    );
    const proxyReceipt = await this.sendAndConfirmTransaction(proxyTx);
    const tokenAddress = this.tronweb.address.fromHex(
      proxyReceipt.contract_address,
    );

    // 3. Initialize the token through the proxy
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(address,address,address)',
        {
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
    // Tron always uses proxy deployment - proxyAdminAddress must be provided
    if (!req.proxyAdminAddress) {
      throw new Error(
        'proxyAdminAddress is required for Tron synthetic token deployment',
      );
    }

    // 1. Deploy token implementation
    const implTx = await this.getCreateSyntheticTokenTransaction({
      ...req,
      signer: this.getSignerAddress(),
    });
    const implReceipt = await this.sendAndConfirmTransaction(implTx);
    const implementationAddress = this.tronweb.address.fromHex(
      implReceipt.contract_address,
    );

    // 2. Deploy TransparentUpgradeableProxy
    const proxyTx = await createDeploymentTransaction(
      this.tronweb,
      TransparentUpgradeableProxyAbi,
      this.getSignerAddress(),
      [implementationAddress, req.proxyAdminAddress, '0x'],
    );
    const proxyReceipt = await this.sendAndConfirmTransaction(proxyTx);
    const tokenAddress = this.tronweb.address.fromHex(
      proxyReceipt.contract_address,
    );

    // 3. Initialize the token through the proxy
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        tokenAddress,
        'initialize(uint256,string,string,address,address,address)',
        {
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
