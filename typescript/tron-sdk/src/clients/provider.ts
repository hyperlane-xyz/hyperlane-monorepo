import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, ensure0x, sleep, strip0x } from '@hyperlane-xyz/utils';

import ERC20Abi from '@hyperlane-xyz/core/tron/abi/@openzeppelin/contracts/token/ERC20/ERC20.sol/ERC20.json' with { type: 'json' };
import HypNativeAbi from '@hyperlane-xyz/core/tron/abi/contracts/token/HypNative.sol/HypNative.json' with { type: 'json' };
import IERC20Abi from '@hyperlane-xyz/core/tron/abi/@openzeppelin/contracts/token/ERC20/IERC20.sol/IERC20.json' with { type: 'json' };
import ProxyAdminAbi from '@hyperlane-xyz/core/tron/abi/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json' with { type: 'json' };
import {
  EIP1967_ADMIN_SLOT,
  TRON_EMPTY_ADDRESS,
  decodeRevertReason,
} from '../utils/index.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

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
  ): Promise<TronReceipt> {
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
    } catch {
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

    const token: AltVM.ResGetToken = {
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
}
