import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, ensure0x, sleep, strip0x } from '@hyperlane-xyz/utils';

import ERC20Abi from '../abi/ERC20.json' with { type: 'json' };
import HypERC20Abi from '../abi/HypERC20.json' with { type: 'json' };
import HypERC20CollateralAbi from '../abi/HypERC20Collateral.json' with { type: 'json' };
import HypNativeAbi from '../abi/HypNative.json' with { type: 'json' };
import IERC20Abi from '../abi/IERC20.json' with { type: 'json' };
import MailboxAbi from '../abi/Mailbox.json' with { type: 'json' };
import MerkleTreeHookAbi from '../abi/MerkleTreeHook.json' with { type: 'json' };
import PausableHookAbi from '../abi/PausableHook.json' with { type: 'json' };
import ProxyAdminAbi from '../abi/ProxyAdmin.json' with { type: 'json' };
import ValidatorAnnounceAbi from '../abi/ValidatorAnnounce.json' with { type: 'json' };
import {
  getHookType,
  getIgpHookConfig,
  getMerkleTreeHookConfig,
} from '../hook/hook-query.js';
import {
  getCreateIgpTx,
  getRemoveIgpOwnerTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
} from '../hook/hook-tx.js';
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
import {
  EIP1967_ADMIN_SLOT,
  TRON_EMPTY_ADDRESS,
  createDeploymentTransaction,
  decodeRevertReason,
} from '../utils/index.js';
import {
  TronHookTypes,
  TronIsmTypes,
  TronTransaction,
} from '../utils/types.js';

export class TronProvider implements AltVM.IProvider {
  protected readonly rpcUrls: string[];

  protected readonly tronweb: TronWeb;

  static async connect(rpcUrls: string[]): Promise<TronProvider> {
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    const { privateKey } = new TronWeb({
      fullHost: rpcUrls[0],
    }).createRandom();
    return new TronProvider(rpcUrls, strip0x(privateKey));
  }

  constructor(rpcUrls: string[], privateKey?: string) {
    this.rpcUrls = rpcUrls;

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

  protected async waitForTransaction(
    txid: string,
    timeout = 30000,
  ): Promise<any> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const info = await this.tronweb.trx.getTransactionInfo(txid);

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
            revertReason = decodeRevertReason(
              info.contractResult[0],
              this.tronweb,
            );
          }

          throw new Error(
            `Tron Transaction Failed: ${revertReason} (txid: ${txid})`,
          );
        }
      }

      await sleep(2000);
    }

    throw new Error(`Transaction timed out: ${txid}`);
  }

  protected async getProxyAdmin(
    proxyAddress: string,
  ): Promise<{ owner: string; address: string } | undefined> {
    let proxyAdmin = undefined;

    try {
      const response: { result: string } = await this.tronweb.fullNode.request(
        'jsonrpc',
        {
          jsonrpc: '2.0',
          method: 'eth_getStorageAt',
          params: [
            ensure0x(this.tronweb.address.toHex(proxyAddress)),
            EIP1967_ADMIN_SLOT,
            'latest',
          ],
          id: 1,
        },
        'POST',
      );

      const ethAddress = strip0x(response.result).slice(-40);
      const tronHex = '41' + ethAddress;

      const proxyAdminAddress = this.tronweb.address.fromHex(tronHex);
      const proxyAdminContract = this.tronweb.contract(
        ProxyAdminAbi.abi,
        proxyAdminAddress,
      );

      proxyAdmin = {
        address: proxyAdminAddress,
        owner: this.tronweb.address.fromHex(
          await proxyAdminContract.owner().call(),
        ),
      };
    } catch (error) {
      // If query fails, leave proxyAdmin empty
    }

    return proxyAdmin;
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
    const ENERGY_MULTIPLIER = 1.5;

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
    const [_, energyPrice] = energyPriceData.split(',').at(-1)!.split(':');

    const bandwidthPriceData = await this.tronweb.trx.getBandwidthPrices();
    const [__, bandwidthPrice] = bandwidthPriceData
      .split(',')
      .at(-1)!
      .split(':');

    const txSize = BigInt(req.transaction.raw_data_hex.length / 2 + 134); // Signature + Result + Protobuf

    const energy = BigInt(Math.ceil(energy_required * ENERGY_MULTIPLIER));

    const energyFee = energy * BigInt(energyPrice);
    const bandwidthFee = txSize * BigInt(bandwidthPrice);
    const totalFeeSun = energyFee + bandwidthFee;

    return {
      gasUnits: energy,
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

    const proxyAdmin = await this.getProxyAdmin(req.mailboxAddress);

    return {
      address: req.mailboxAddress,
      owner: this.tronweb.address.fromHex(await mailbox.owner().call()),
      localDomain: Number(await mailbox.localDomain().call()),
      defaultIsm: defaultIsm === req.mailboxAddress ? '' : defaultIsm,
      defaultHook: defaultHook === req.mailboxAddress ? '' : defaultHook,
      requiredHook: requiredHook === req.mailboxAddress ? '' : requiredHook,
      nonce: Number(await mailbox.nonce().call()),
      proxyAdmin,
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
        throw new Error(`Unknown ISM ModuleType: ${hookType}`);
    }
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    return getIgpHookConfig(this.tronweb, req.hookAddress);
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    return getMerkleTreeHookConfig(this.tronweb, req.hookAddress);
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

    let token: AltVM.ResGetToken = {
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
      proxyAdmin: await this.getProxyAdmin(req.tokenAddress),
    };

    if (tokenType === AltVM.TokenType.native) {
      return token;
    }

    const erc20 = this.tronweb.contract(ERC20Abi.abi, denom);

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

      remoteRouters.push({
        receiverDomainId: Number(domainId),
        receiverAddress: await contract.routers(domainId).call(),
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
    assert(req.recipient, `Tron quote remote transfer needs the recipient`);
    assert(req.amount, `Tron quote remote transfer needs the amount`);

    const contract = this.tronweb.contract(HypNativeAbi.abi, req.tokenAddress);

    const { quotes } = await contract
      .quoteTransferRemote(req.destinationDomainId, req.recipient, req.amount)
      .call();

    if (!quotes.length) {
      return {
        denom: '',
        amount: BigInt(0),
      };
    }

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
    return createDeploymentTransaction(this.tronweb, MailboxAbi, req.signer, [
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
    return createDeploymentTransaction(
      this.tronweb,
      MerkleTreeHookAbi,
      req.signer,
      [req.mailboxAddress],
    );
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<TronTransaction> {
    return getCreateIgpTx(this.tronweb, req.signer);
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<TronTransaction> {
    return getSetIgpOwnerTx(this.tronweb, req.signer, {
      igpAddress: req.hookAddress,
      newOwner: req.newOwner,
    });
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
    return getRemoveIgpOwnerTx(this.tronweb, req.signer, {
      igpAddress: req.hookAddress,
      remoteDomainId: req.remoteDomainId,
    });
  }

  async getCreateNoopHookTransaction(
    req: AltVM.ReqCreateNoopHook,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(
      this.tronweb,
      PausableHookAbi,
      req.signer,
      [],
    );
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(
      this.tronweb,
      ValidatorAnnounceAbi,
      req.signer,
      [req.mailboxAddress],
    );
  }

  async getCreateProxyAdminTransaction(
    req: AltVM.ReqCreateProxyAdmin,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(
      this.tronweb,
      ProxyAdminAbi,
      req.signer,
      [],
    );
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    req: AltVM.ReqCreateNativeToken,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(this.tronweb, HypNativeAbi, req.signer, [
      1,
      req.mailboxAddress,
    ]);
  }

  async getCreateCollateralTokenTransaction(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(
      this.tronweb,
      HypERC20CollateralAbi,
      req.signer,
      [req.collateralDenom, 1, req.mailboxAddress],
    );
  }

  async getCreateSyntheticTokenTransaction(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<TronTransaction> {
    return createDeploymentTransaction(this.tronweb, HypERC20Abi, req.signer, [
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
            callValue: 0,
          },
          [
            {
              type: 'address',
              value: [req.recipient],
            },
            {
              type: 'uint256',
              value: [req.amount],
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
    const { tokenType } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const { transaction } =
      await this.tronweb.transactionBuilder.triggerSmartContract(
        req.tokenAddress,
        'transferRemote(uint32,bytes32,uint256)',
        {
          callValue:
            tokenType === AltVM.TokenType.native ? Number(req.amount) : 0,
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
