import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import { Address } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp.js';
import {
  BeneficiaryResponse,
  DefaultGasResponse,
  DomainsResponse,
  GetExchangeRateAndGasPriceResponse,
  OwnerResponse,
  QueryMsg,
  QuoteGasPaymentResponse,
  RouteResponseForAddr,
  RoutesResponseForAddr,
} from '../../cw-types/Igp.types.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../../types.js';

// TODO: import more
type IgpResponse =
  | OwnerResponse
  | BeneficiaryResponse
  | DomainsResponse
  | GetExchangeRateAndGasPriceResponse
  | RoutesResponseForAddr
  | RouteResponseForAddr
  | DefaultGasResponse
  | QuoteGasPaymentResponse;

export class CosmWasmIgpAdapter extends BaseCosmWasmAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { igp: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryIgp<R extends IgpResponse>(msg: QueryMsg): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.igp,
      msg,
    );
    return response;
  }

  async owner(): Promise<string> {
    const response = await this.queryIgp<OwnerResponse>({
      ownable: {
        get_owner: {},
      },
    });
    return response.owner;
  }

  async beneficiary(): Promise<string> {
    const beneficiaryResponse: BeneficiaryResponse = await this.queryIgp({
      igp: {
        beneficiary: {},
      },
    });
    return beneficiaryResponse.beneficiary;
  }

  async getOracles(): Promise<ChainMap<Address>> {
    const domainResponse: RoutesResponseForAddr = await this.queryIgp({
      router: {
        list_routes: {},
      },
    });

    return Object.fromEntries(
      domainResponse.routes.map((_) => [
        this.multiProvider.getChainName(_.domain),
        _.route ?? '',
      ]),
    );
  }

  async defaultGas(): Promise<number> {
    const defaultGas = await this.queryIgp<DefaultGasResponse>({
      igp: {
        default_gas: {},
      },
    });
    return defaultGas.gas;
  }

  async getOracleData(
    chain: ChainName,
  ): Promise<GetExchangeRateAndGasPriceResponse> {
    const provider = await this.getProvider();
    const domain = this.multiProvider.getDomainId(chain);
    const oracles = await this.getOracles();
    const oracle = oracles[chain];
    const oracleResponse: GetExchangeRateAndGasPriceResponse =
      await provider.queryContractSmart(oracle, {
        oracle: {
          get_exchange_rate_and_gas_price: {
            dest_domain: domain,
          },
        },
      });
    return oracleResponse;
  }

  async quoteGasPayment(
    domain: number,
    destinationGasAmount: number,
  ): Promise<number> {
    const quote: QuoteGasPaymentResponse = await this.queryIgp({
      igp: {
        quote_gas_payment: {
          dest_domain: domain,
          gas_amount: destinationGasAmount.toString(),
        },
      },
    });
    return Number(quote.gas_needed);
  }

  setOracleForDomain(
    domain: number,
    oracle: string,
    oracleData: GetExchangeRateAndGasPriceResponse,
  ): ExecuteInstruction {
    return {
      contractAddress: oracle,
      msg: {
        set_remote_gas_data: {
          config: {
            gas_price: oracleData.gas_price,
            token_exchange_rate: oracleData.exchange_rate,
            remote_domain: domain,
          },
        },
      },
    };
  }
}
