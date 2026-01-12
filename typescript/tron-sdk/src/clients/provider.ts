import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import InterchainGasPaymasterAbi from '../../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MailboxAbi from '../../abi/Mailbox.json' with { type: 'json' };
import MerkleTreeHookAbi from '../../abi/MerkleTreeHook.json' with { type: 'json' };
import NoopIsmAbi from '../../abi/NoopIsm.json' with { type: 'json' };
import MessageIdMultisigIsmAbi from '../../abi/StorageMessageIdMultisigIsm.json' with { type: 'json' };
import ValidatorAnnounceAbi from '../../abi/ValidatorAnnounce.json' with { type: 'json' };
import { IABI, TronTransaction } from '../utils/types.js';

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

  protected async createDeploymentTransaction(
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
    _req: AltVM.ReqEstimateTransactionFee<TronTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    throw new Error(`not implemented`);
  }

  // ### QUERY CORE ###

  // TODO: TRON
  // use multicall
  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const contract = this.tronweb.contract(MailboxAbi.abi, req.mailboxAddress);

    const defaultIsm = this.tronweb.address.fromHex(
      await contract.defaultIsm().call(),
    );

    const defaultHook = this.tronweb.address.fromHex(
      await contract.defaultHook().call(),
    );

    const requiredHook = this.tronweb.address.fromHex(
      await contract.requiredHook().call(),
    );

    return {
      address: req.mailboxAddress,
      owner: this.tronweb.address.fromHex(await contract.owner().call()),
      localDomain: Number(await contract.localDomain().call()),
      defaultIsm: defaultIsm === req.mailboxAddress ? '' : defaultIsm,
      defaultHook: defaultHook === req.mailboxAddress ? '' : defaultHook,
      requiredHook: requiredHook === req.mailboxAddress ? '' : requiredHook,
      nonce: Number(await contract.nonce().call()),
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
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const contract = this.tronweb.contract(
      MessageIdMultisigIsmAbi.abi,
      req.ismAddress,
    );

    return {
      address: req.ismAddress,
      threshold: Number(await contract.threshold().call()),
      validators: await contract.validators().call(),
    };
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error(`not implemented`);
  }

  async getRoutingIsm(_req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    throw new Error(`not implemented`);
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const contract = this.tronweb.contract(NoopIsmAbi.abi, req.ismAddress);

    const moduleType = await contract.moduleType().call();
    assert(Number(moduleType) === 6, `module type does not equal NULL_ISM`);

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(_req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    throw new Error(`not implemented`);
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const igp = this.tronweb.contract(
      InterchainGasPaymasterAbi.abi,
      req.hookAddress,
    );

    const hookType = await igp.hookType().call();
    assert(
      Number(hookType) === 4,
      `hook type does not equal INTERCHAIN_GAS_PAYMASTER`,
    );

    const domainIds = await igp.getAllDomainIds().call();

    let destinationGasConfigs = {} as {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    };

    for (const domainId of domainIds) {
      const c = await igp.destinationGasConfigs(domainId).call();

      // console.log(domainId, c, this.tronweb.address.fromHex(c.gasOracle));

      // const gasOracle = this.tronweb.contract(
      //   StorageGasOracleAbi.abi,
      //   this.tronweb.address.fromHex(c.gasOracle),
      // );

      // console.log('gasOracle', await gasOracle.remoteGasData(domainId).call());

      destinationGasConfigs[domainId.toString()] = {
        gasOracle: {
          tokenExchangeRate: '0',
          gasPrice: '0',
        },
        gasOverhead: c.gasOverhead.toString(),
      };
    }

    return {
      address: req.hookAddress,
      owner: this.tronweb.address.fromHex(await igp.owner().call()),
      destinationGasConfigs,
    };
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    const contract = this.tronweb.contract(
      MerkleTreeHookAbi.abi,
      req.hookAddress,
    );

    const hookType = await contract.hookType().call();
    assert(Number(hookType) === 3, `hook type does not equal MERKLE_TREE`);

    return {
      address: req.hookAddress,
    };
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
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(MailboxAbi, req.signer, [
      req.domainId,
    ]);
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<TronTransaction> {
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
    req: AltVM.ReqSetDefaultHook,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.mailboxAddress,
        'setDefaultHook(address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: req.hookAddress,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.mailboxAddress,
        'setRequiredHook(address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: req.hookAddress,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.mailboxAddress,
        'transferOwnership(address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'address',
            value: req.newOwner,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMessageIdMultisigIsmTransaction(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(
      MessageIdMultisigIsmAbi,
      req.signer,
      [req.validators, req.threshold],
    );
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopIsmTransaction(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(NoopIsmAbi, req.signer, []);
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(MerkleTreeHookAbi, req.signer, [
      req.mailboxAddress,
    ]);
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(
      InterchainGasPaymasterAbi,
      req.signer,
      [],
    );
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<TronTransaction> {
    const igp = this.tronweb.contract(
      InterchainGasPaymasterAbi.abi,
      req.hookAddress,
    );

    const hookType = await igp.hookType().call();
    assert(
      Number(hookType) === 4,
      `hook type does not equal INTERCHAIN_GAS_PAYMASTER`,
    );

    const gasOracle = await igp.gasOracle().call();

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.hookAddress,
        'setDestinationGasConfigs((uint32,(address,uint96))[])',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'tuple(uint32 remoteDomain, tuple(address gasOracle, uint96 gasOverhead) config)[]',
            value: [
              {
                remoteDomain: Number(req.destinationGasConfig.remoteDomainId),
                config: {
                  gasOracle: gasOracle.replace('41', '0x'),
                  gasOverhead: req.destinationGasConfig.gasOverhead.toString(),
                },
              },
            ],
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(ValidatorAnnounceAbi, req.signer, [
      req.mailboxAddress,
    ]);
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenHookTransaction(
    _req: AltVM.ReqSetTokenHook,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getTransferTransaction(
    _req: AltVM.ReqTransfer,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<TronTransaction> {
    throw new Error(`not implemented`);
  }
}
