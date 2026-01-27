import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import ERC20TestAbi from '../abi/ERC20Test.json' with { type: 'json' };
import HypERC20Abi from '../abi/HypERC20.json' with { type: 'json' };
import HypERC20CollateralAbi from '../abi/HypERC20Collateral.json' with { type: 'json' };
import HypNativeAbi from '../abi/HypNative.json' with { type: 'json' };
import IERC20Abi from '../abi/IERC20.json' with { type: 'json' };
import InterchainGasPaymasterAbi from '../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MailboxAbi from '../abi/Mailbox.json' with { type: 'json' };
import MerkleTreeHookAbi from '../abi/MerkleTreeHook.json' with { type: 'json' };
import PausableHookAbi from '../abi/PausableHook.json' with { type: 'json' };
import StorageGasOracleAbi from '../abi/StorageGasOracle.json' with { type: 'json' };
import ValidatorAnnounceAbi from '../abi/ValidatorAnnounce.json' with { type: 'json' };
import { getHookType } from '../hook/hook-query.js';
import { getSetIgpDestinationGasConfigTx } from '../hook/hook-tx.js';
import {
  getIsmType,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
  getNoopIsmConfig,
  getRoutingIsmConfig,
} from '../ism/ism-query.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
  getCreateRoutingIsmTx,
  getCreateTestIsmTx,
  getRemoveRoutingIsmRouteTx,
  getSetRoutingIsmOwnerTx,
  getSetRoutingIsmRouteTx,
} from '../ism/ism-tx.js';
import { TRON_EMPTY_ADDRESS, TRON_MAX_FEE } from '../utils/index.js';
import {
  IABI,
  TronHookTypes,
  TronIsmTypes,
  TronTransaction,
} from '../utils/types.js';

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
    return new TronProvider(rpcUrls, chainId, strip0x(privateKey));
  }

  constructor(
    rpcUrls: string[],
    chainId: string | number,
    privateKey?: string,
  ) {
    this.rpcUrls = rpcUrls;
    this.chainId = +chainId;

    if (!privateKey) {
      privateKey = new TronWeb({
        fullHost: rpcUrls[0],
      }).createRandom().privateKey;
    }

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

    return this.tronweb.transactionBuilder.createSmartContract(options, signer);
  }

  protected async waitForTransaction(
    txid: string,
    timeout = 30000,
  ): Promise<any> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      let info;

      try {
        info = await this.tronweb.trx.getTransactionInfo(txid);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      if (info && info.id) {
        const result = info.receipt?.result;

        if (result === 'SUCCESS') {
          return info;
        }

        if (result === 'REVERT' || result === 'FAILED') {
          let revertReason = 'Unknown Error';

          if (info.resMessage) {
            revertReason = this.tronweb.toUtf8(info.resMessage);
          } else if (info.contractResult && info.contractResult[0]) {
            revertReason = info.contractResult[0];
          }

          throw new Error(
            `Tron Transaction Failed: ${revertReason} (txid: ${txid})`,
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Transaction timed out: ${txid}`);
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
    if (req.denom && req.denom !== 'SUN') {
      const erc20 = this.tronweb.contract(IERC20Abi.abi, req.denom);
      const balance = await erc20.balanceOf(req.address).call();
      return BigInt(balance);
    }

    const balance = await this.tronweb.trx.getBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    if (req.denom) {
      const erc20 = this.tronweb.contract(IERC20Abi.abi, req.denom);
      const supply = await erc20.totalSupply().call();
      return BigInt(supply);
    }

    throw new Error(`Native TRX has no total supply`);
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<TronTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const value = req.transaction.raw_data.contract[0].parameter.value;
    const contractAddress = value.contract_address;
    const issuerAddress = value.owner_address;
    const callValue = value.call_value || 0;

    const { result, energy_required } =
      await this.tronweb.transactionBuilder.estimateEnergy(
        contractAddress,
        '',
        {
          input: value.data,
          callValue,
        },
        [],
        issuerAddress,
      );

    if (!result.result) {
      throw new Error(
        `energy estimation failed for txid ${req.transaction.txID}`,
      );
    }

    const energyPriceData = await this.tronweb.trx.getEnergyPrices();
    const energyParts = energyPriceData.split(',').at(-1);
    if (!energyParts) {
      throw new Error('Failed to retrieve energy price data');
    }

    const [_, energyPrice] = energyParts.split(':');
    const bandwidthPriceData = await this.tronweb.trx.getBandwidthPrices();
    const bandwidthParts = bandwidthPriceData.split(',').at(-1);
    if (!bandwidthParts) {
      throw new Error('Failed to retrieve bandwidth price data');
    }

    const [__, bandwidthPrice] = bandwidthParts.split(':');
    const txSize = BigInt(req.transaction.raw_data_hex.length / 2 + 134); // Signature + Result + Protobuf
    const energyFee = BigInt(energy_required) * BigInt(energyPrice);
    const bandwidthFee = txSize * BigInt(bandwidthPrice);
    const totalFeeSun = energyFee + bandwidthFee;

    return {
      gasUnits: BigInt(energy_required),
      gasPrice: parseInt(energyPrice),
      fee: totalFeeSun,
    };
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const mailbox = this.tronweb.contract(MailboxAbi.abi, req.mailboxAddress);

    const defaultIsm = this.tronweb.address.fromHex(
      await mailbox.defaultIsm().call(),
    );

    const defaultHook = this.tronweb.address.fromHex(
      await mailbox.defaultHook().call(),
    );

    const requiredHook = this.tronweb.address.fromHex(
      await mailbox.requiredHook().call(),
    );

    return {
      address: req.mailboxAddress,
      owner: this.tronweb.address.fromHex(await mailbox.owner().call()),
      localDomain: Number(await mailbox.localDomain().call()),
      defaultIsm: defaultIsm === req.mailboxAddress ? '' : defaultIsm,
      defaultHook: defaultHook === req.mailboxAddress ? '' : defaultHook,
      requiredHook: requiredHook === req.mailboxAddress ? '' : requiredHook,
      nonce: Number(await mailbox.nonce().call()),
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    const mailbox = this.tronweb.contract(MailboxAbi.abi, req.mailboxAddress);
    return mailbox.delivered(req.messageId).call();
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const ismType = await getIsmType(this.tronweb, req.ismAddress);

    switch (ismType) {
      case TronIsmTypes.MERKLE_ROOT_MULTISIG: {
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      }
      case TronIsmTypes.MESSAGE_ID_MULTISIG: {
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      }
      case TronIsmTypes.ROUTING_ISM: {
        return AltVM.IsmType.ROUTING;
      }
      case TronIsmTypes.NOOP_ISM: {
        return AltVM.IsmType.TEST_ISM;
      }
      default:
        throw new Error(`Unknown ISM ModuleType: ${ismType}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    return getMessageIdMultisigIsmConfig(this.tronweb, req.ismAddress);
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    return getMerkleRootMultisigIsmConfig(this.tronweb, req.ismAddress);
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    return getRoutingIsmConfig(this.tronweb, req.ismAddress);
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    return getNoopIsmConfig(this.tronweb, req.ismAddress);
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const hookType = await getHookType(this.tronweb, req.hookAddress);

    switch (hookType) {
      case TronHookTypes.MERKLE_TREE: {
        return AltVM.HookType.MERKLE_TREE;
      }
      case TronHookTypes.INTERCHAIN_GAS_PAYMASTER: {
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      }
      default:
        throw new Error(`Unknown Hook Type: ${hookType}`);
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

    const domainIds = await igp.domains().call();

    const destinationGasConfigs = {} as {
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

  async getNoopHook(req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    const contract = this.tronweb.contract(
      PausableHookAbi.abi,
      req.hookAddress,
    );

    const hookType = await contract.hookType().call();
    assert(Number(hookType) === 7, `hook type does not equal PAUSABLE_HOOK`);

    return {
      address: req.hookAddress,
    };
  }

  // ### QUERY WARP ###

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const contract = this.tronweb.contract(HypNativeAbi.abi, req.tokenAddress);

    const ismAddress = this.tronweb.address.fromHex(
      await contract.interchainSecurityModule().call(),
    );
    const hookAddress = this.tronweb.address.fromHex(
      await contract.hook().call(),
    );
    const denom = this.tronweb.address.fromHex(await contract.token().call());

    let tokenType = AltVM.TokenType.native;

    if (denom === TRON_EMPTY_ADDRESS) {
      tokenType = AltVM.TokenType.native;
    } else if (denom === req.tokenAddress) {
      tokenType = AltVM.TokenType.synthetic;
    } else {
      tokenType = AltVM.TokenType.collateral;
    }

    const token = {
      address: req.tokenAddress,
      owner: this.tronweb.address.fromHex(await contract.owner().call()),
      tokenType,
      mailboxAddress: this.tronweb.address.fromHex(
        await contract.mailbox().call(),
      ),
      ismAddress: ismAddress === TRON_EMPTY_ADDRESS ? '' : ismAddress,
      hookAddress: hookAddress === TRON_EMPTY_ADDRESS ? '' : hookAddress,
      denom: denom === TRON_EMPTY_ADDRESS ? '' : denom,
      name: '',
      symbol: '',
      decimals: 0,
    };

    if (tokenType === AltVM.TokenType.native) {
      return token;
    }

    const erc20 = this.tronweb.contract(ERC20TestAbi.abi, denom);

    token.name = await erc20.name().call();
    token.symbol = await erc20.symbol().call();
    token.decimals = Number(await erc20.decimals().call());

    return token;
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const contract = this.tronweb.contract(HypNativeAbi.abi, req.tokenAddress);

    const remoteRouters: {
      receiverDomainId: number;
      receiverAddress: string;
      gas: string;
    }[] = [];

    const domainIds = await contract.domains().call();

    for (const domainId of domainIds) {
      const { gasLimit } = await contract.destinationGas(domainId).call();
      const receiver = await contract.routers(domainId).call();

      remoteRouters.push({
        receiverDomainId: Number(domainId),
        receiverAddress: ensure0x(receiver),
        gas: gasLimit.toString(),
      });
    }

    return {
      address: req.tokenAddress,
      remoteRouters,
    };
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const { tokenType, denom } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    switch (tokenType) {
      case AltVM.TokenType.native: {
        return this.getBalance({
          address: req.tokenAddress,
          denom: '',
        });
      }
      case AltVM.TokenType.synthetic: {
        return this.getTotalSupply({
          denom: req.tokenAddress,
        });
      }
      case AltVM.TokenType.collateral: {
        return this.getBalance({
          address: req.tokenAddress,
          denom,
        });
      }
      default: {
        throw new Error(`Unknown token type ${tokenType}`);
      }
    }
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const contract = this.tronweb.contract(HypNativeAbi.abi, req.tokenAddress);

    const { quotes } = await contract
      .quoteTransferRemote(
        req.destinationDomainId,
        '0x726f757465725f61707000000000000000000000000000020000000000000005',
        1000000,
      )
      .call();

    const denom = this.tronweb.address.fromHex(quotes[0].token);

    return {
      denom: denom === TRON_EMPTY_ADDRESS ? '' : denom,
      amount: quotes[0].amount,
    };
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
          feeLimit: TRON_MAX_FEE,
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
          feeLimit: TRON_MAX_FEE,
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
          feeLimit: TRON_MAX_FEE,
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
          feeLimit: TRON_MAX_FEE,
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
    return getCreateMerkleRootMultisigIsmTx(this.tronweb, req.signer, {
      validators: req.validators,
      threshold: req.threshold,
    });
  }

  async getCreateMessageIdMultisigIsmTransaction(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<TronTransaction> {
    return getCreateMessageIdMultisigIsmTx(this.tronweb, req.signer, {
      validators: req.validators,
      threshold: req.threshold,
    });
  }

  async getCreateRoutingIsmTransaction(
    req: AltVM.ReqCreateRoutingIsm,
  ): Promise<TronTransaction> {
    return getCreateRoutingIsmTx(this.tronweb, req.signer);
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<TronTransaction> {
    return getSetRoutingIsmRouteTx(this.tronweb, req.signer, {
      ismAddress: req.ismAddress,
      domainIsm: req.route,
    });
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<TronTransaction> {
    return getRemoveRoutingIsmRouteTx(this.tronweb, req.signer, {
      ismAddress: req.ismAddress,
      domainId: req.domainId,
    });
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<TronTransaction> {
    return getSetRoutingIsmOwnerTx(this.tronweb, req.signer, {
      ismAddress: req.ismAddress,
      newOwner: req.newOwner,
    });
  }

  async getCreateNoopIsmTransaction(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<TronTransaction> {
    return getCreateTestIsmTx(this.tronweb, req.signer);
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
          feeLimit: TRON_MAX_FEE,
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
    return getSetIgpDestinationGasConfigTx(this.tronweb, req.signer, {
      igpAddress: req.hookAddress,
      destinationGasConfigs: [
        {
          remoteDomainId: req.destinationGasConfig.remoteDomainId,
          gasOverhead: req.destinationGasConfig.gasOverhead,
        },
      ],
    });
  }

  async getRemoveDestinationGasConfigTransaction(
    req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.hookAddress,
        'removeDestinationGasConfigs(uint32[])',
        {
          feeLimit: TRON_MAX_FEE,
          callValue: 0,
        },
        [
          {
            type: 'uint32[]',
            value: [req.remoteDomainId],
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getCreateNoopHookTransaction(
    req: AltVM.ReqCreateNoopHook,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(PausableHookAbi, req.signer, []);
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
    req: AltVM.ReqCreateNativeToken,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(HypNativeAbi, req.signer, [
      1,
      req.mailboxAddress,
    ]);
  }

  async getCreateCollateralTokenTransaction(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(HypERC20CollateralAbi, req.signer, [
      req.collateralDenom,
      1,
      req.mailboxAddress,
    ]);
  }

  async getCreateSyntheticTokenTransaction(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<TronTransaction> {
    return this.createDeploymentTransaction(HypERC20Abi, req.signer, [
      req.decimals,
      1,
      req.mailboxAddress,
    ]);
  }

  async getSetTokenOwnerTransaction(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'transferOwnership(address)',
        {
          feeLimit: TRON_MAX_FEE,
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

  async getSetTokenIsmTransaction(
    req: AltVM.ReqSetTokenIsm,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'setInterchainSecurityModule(address)',
        {
          feeLimit: TRON_MAX_FEE,
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

  async getSetTokenHookTransaction(
    req: AltVM.ReqSetTokenHook,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'setHook(address)',
        {
          feeLimit: TRON_MAX_FEE,
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

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'enrollRemoteRouter(uint32,bytes32)',
        {
          feeLimit: TRON_MAX_FEE,
          callValue: 0,
        },
        [
          {
            type: 'uint32',
            value: req.remoteRouter.receiverDomainId,
          },
          {
            type: 'bytes32',
            value: ensure0x(req.remoteRouter.receiverAddress),
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getUnenrollRemoteRouterTransaction(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'unenrollRemoteRouter(uint32)',
        {
          feeLimit: TRON_MAX_FEE,
          callValue: 0,
        },
        [
          {
            type: 'uint32',
            value: req.receiverDomainId,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<TronTransaction> {
    if (req.denom) {
      const { transaction } =
        await this.tronweb.transactionBuilder.triggerSmartContract(
          req.denom,
          'transfer(address,uint256)',
          {
            feeLimit: TRON_MAX_FEE,
            callValue: 0,
          },
          [
            {
              type: 'address',
              value: req.recipient,
            },
            {
              type: 'uint256',
              value: req.amount,
            },
          ],
          this.tronweb.address.toHex(req.signer),
        );

      return transaction;
    }

    return this.tronweb.transactionBuilder.sendTrx(
      req.recipient,
      parseInt(req.amount),
      req.signer,
    );
  }

  async getRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<TronTransaction> {
    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'transferRemote(uint32,bytes32,uint256)',
        {
          feeLimit: TRON_MAX_FEE,
          callValue: Number(req.amount),
        },
        [
          {
            type: 'uint32',
            value: req.destinationDomainId,
          },
          {
            type: 'bytes32',
            value: ensure0x(req.recipient),
          },
          {
            type: 'uint256',
            value: req.amount,
          },
        ],
        this.tronweb.address.toHex(req.signer),
      );

    return transaction;
  }
}
