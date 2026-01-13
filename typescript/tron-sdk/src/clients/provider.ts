import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import DomainRoutingIsmAbi from '../../abi/DomainRoutingIsm.json' with { type: 'json' };
import IInterchainSecurityModuleAbi from '../../abi/IInterchainSecurityModule.json' with { type: 'json' };
import IPostDispatchHookAbi from '../../abi/IPostDispatchHook.json' with { type: 'json' };
import InterchainGasPaymasterAbi from '../../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MailboxAbi from '../../abi/Mailbox.json' with { type: 'json' };
import MerkleTreeHookAbi from '../../abi/MerkleTreeHook.json' with { type: 'json' };
import NoopIsmAbi from '../../abi/NoopIsm.json' with { type: 'json' };
import StorageGasOracleAbi from '../../abi/StorageGasOracle.json' with { type: 'json' };
import StorageMerkleRootMultisigIsmAbi from '../../abi/StorageMerkleRootMultisigIsm.json' with { type: 'json' };
import StorageMessageIdMultisigIsmAbi from '../../abi/StorageMessageIdMultisigIsm.json' with { type: 'json' };
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

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const contract = this.tronweb.contract(
      IInterchainSecurityModuleAbi.abi,
      req.ismAddress,
    );

    const moduleType = Number(await contract.moduleType().call());

    switch (moduleType) {
      case 1:
        return AltVM.IsmType.ROUTING;
      case 4:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case 5:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      case 6:
        return AltVM.IsmType.TEST_ISM;
      default:
        throw new Error(`Unknown ISM type for address: ${req.ismAddress}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const contract = this.tronweb.contract(
      StorageMessageIdMultisigIsmAbi.abi,
      req.ismAddress,
    );

    return {
      address: req.ismAddress,
      threshold: Number(await contract.threshold().call()),
      validators: await contract.validators().call(),
    };
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    const contract = this.tronweb.contract(
      StorageMerkleRootMultisigIsmAbi.abi,
      req.ismAddress,
    );

    return {
      address: req.ismAddress,
      threshold: await contract.threshold().call(),
      validators: await contract.validators().call(),
    };
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    const contract = this.tronweb.contract(
      DomainRoutingIsmAbi.abi,
      req.ismAddress,
    );

    const routes = [];

    const domainIds = await contract.domains().call();

    for (const domainId of domainIds) {
      const ismAddress = this.tronweb.address.fromHex(
        await contract.module(domainId).call(),
      );
      routes.push({
        domainId: Number(domainId),
        ismAddress,
      });
    }

    return {
      address: req.ismAddress,
      owner: this.tronweb.address.fromHex(await contract.owner().call()),
      routes,
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const contract = this.tronweb.contract(NoopIsmAbi.abi, req.ismAddress);

    const moduleType = await contract.moduleType().call();
    assert(Number(moduleType) === 6, `module type does not equal NULL_ISM`);

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const contract = this.tronweb.contract(
      IPostDispatchHookAbi.abi,
      req.hookAddress,
    );

    const hookType = Number(await contract.hookType().call());

    switch (hookType) {
      case 3:
        return AltVM.HookType.MERKLE_TREE;
      case 4:
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      default:
        throw new Error(`Unknown Hook type for address: ${req.hookAddress}`);
    }
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

      const gasOracle = this.tronweb.contract(
        StorageGasOracleAbi.abi,
        this.tronweb.address.fromHex(c.gasOracle),
      );

      const { tokenExchangeRate, gasPrice } = await gasOracle
        .remoteGasData(domainId)
        .call();

      destinationGasConfigs[domainId.toString()] = {
        gasOracle: {
          tokenExchangeRate: tokenExchangeRate.toString(),
          gasPrice: gasPrice.toString(),
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
    req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(
      StorageMerkleRootMultisigIsmAbi,
      req.signer,
      [[], 0],
    );
  }

  async getCreateMessageIdMultisigIsmTransaction(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(
      StorageMessageIdMultisigIsmAbi,
      req.signer,
      [req.validators, req.threshold],
    );
  }

  async getCreateRoutingIsmTransaction(
    req: AltVM.ReqCreateRoutingIsm,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(
      DomainRoutingIsmAbi,
      req.signer,
      [],
    );
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.ismAddress,
        'set(uint32,address)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'uint32',
            value: req.route.domainId,
          },
          {
            type: 'address',
            value: req.route.ismAddress,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.ismAddress,
        'remove(uint32)',
        {
          feeLimit: 100_000_000,
          callValue: 0,
        },
        [
          {
            type: 'uint32',
            value: req.domainId,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.ismAddress,
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
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.hookAddress,
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
