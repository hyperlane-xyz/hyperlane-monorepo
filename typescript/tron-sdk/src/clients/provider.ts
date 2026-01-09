import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import InterchainGasPaymasterAbi from '../../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MailboxAbi from '../../abi/Mailbox.json' with { type: 'json' };
import MerkleTreeHookAbi from '../../abi/MerkleTreeHook.json' with { type: 'json' };
import NoopIsmAbi from '../../abi/NoopIsm.json' with { type: 'json' };
import { IABI } from '../utils/types.js';

type MockTransaction = any;

export class TronProvider implements AltVM.IProvider {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;

  protected readonly tronweb: TronWeb;

  static async connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<TronProvider> {
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    const { privateKey } = new TronWeb({
      fullHost: rpcUrls[0],
    }).createRandom();
    return new TronProvider(rpcUrls, chainId, privateKey);
  }

  constructor(rpcUrls: string[], chainId: string | number, privateKey: string) {
    this.rpcUrls = rpcUrls;
    this.chainId = +chainId;

    this.tronweb = new TronWeb({
      fullHost: this.rpcUrls[0],
      privateKey: strip0x(privateKey),
    });
  }

  private async createDeploymentTransaction(
    abi: IABI,
    signer: string,
    parameters: unknown[],
  ): Promise<any> {
    const options = {
      feeLimit: 1_000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      abi: abi.abi,
      bytecode: abi.bytecode,
      parameters,
      name: abi.contractName,
    };

    return this.tronweb.transactionBuilder.createSmartContract(
      options,
      this.tronweb.address.toHex(signer),
    );
  }

  // ### QUERY BASE ###

  async isHealthy(): Promise<boolean> {
    const block = await this.tronweb.trx.getCurrentBlock();
    return block.block_header.raw_data.number > 0;
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight(): Promise<number> {
    const block = await this.tronweb.trx.getCurrentBlock();
    return block.block_header.raw_data.number;
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    const balance = await this.tronweb.trx.getBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async estimateTransactionFee(
    _req: AltVM.ReqEstimateTransactionFee<MockTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    throw new Error(`not implemented`);
  }

  // ### QUERY CORE ###

  // TODO: TRON
  // use multicall
  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const mailbox = this.tronweb.contract(MailboxAbi.abi, req.mailboxAddress);

    return {
      address: req.mailboxAddress,
      owner: await mailbox.owner().call(),
      localDomain: Number(await mailbox.localDomain().call()),
      defaultIsm: await mailbox.defaultIsm().call(),
      defaultHook: await mailbox.defaultHook().call(),
      requiredHook: await mailbox.requiredHook().call(),
      nonce: Number(await mailbox.nonce().call()),
    };
  }

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error(`not implemented`);
  }

  async getIsmType(_req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    throw new Error(`not implemented`);
  }

  async getMessageIdMultisigIsm(
    _req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    throw new Error(`not implemented`);
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error(`not implemented`);
  }

  async getRoutingIsm(_req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    throw new Error(`not implemented`);
  }

  async getNoopIsm(_req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    throw new Error(`not implemented`);
  }

  async getHookType(_req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    throw new Error(`not implemented`);
  }

  async getInterchainGasPaymasterHook(
    _req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    throw new Error(`not implemented`);
  }

  async getMerkleTreeHook(
    _req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    throw new Error(`not implemented`);
  }

  async getNoopHook(_req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    throw new Error(`not implemented`);
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(`not implemented`);
  }

  async getRemoteRouters(
    _req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    throw new Error(`not implemented`);
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(`not implemented`);
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<MockTransaction> {
    return this.createDeploymentTransaction(MailboxAbi, req.signer, [
      req.domainId,
    ]);
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<MockTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.mailboxAddress,
        'setDefaultIsm(address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: req.ismAddress,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getSetDefaultHookTransaction(
    _req: AltVM.ReqSetDefaultHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRequiredHookTransaction(
    _req: AltVM.ReqSetRequiredHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetMailboxOwnerTransaction(
    _req: AltVM.ReqSetMailboxOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMessageIdMultisigIsmTransaction(
    _req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopIsmTransaction(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<MockTransaction> {
    return this.createDeploymentTransaction(NoopIsmAbi, req.signer, []);
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<MockTransaction> {
    return this.createDeploymentTransaction(MerkleTreeHookAbi, req.signer, [
      req.mailboxAddress,
    ]);
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<MockTransaction> {
    return this.createDeploymentTransaction(
      InterchainGasPaymasterAbi,
      req.signer,
      [],
    );
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetDestinationGasConfigTransaction(
    _req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenHookTransaction(
    _req: AltVM.ReqSetTokenHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getTransferTransaction(
    _req: AltVM.ReqTransfer,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }
}
