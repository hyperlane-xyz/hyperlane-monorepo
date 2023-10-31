/**
 * This file was automatically generated by @cosmwasm/ts-codegen@0.35.3.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run the @cosmwasm/ts-codegen generate command to regenerate this file.
 */

export interface InstantiateMsg {
  beneficiary: string;
  gas_token: string;
  hrp: string;
  owner: string;
}
export type ExecuteMsg =
  | {
      ownable: OwnableMsg;
    }
  | {
      router: RouterMsgForAddr;
    }
  | {
      post_dispatch: PostDispatchMsg;
    }
  | {
      set_beneficiary: {
        beneficiary: string;
      };
    }
  | {
      pay_for_gas: {
        dest_domain: number;
        gas_amount: Uint256;
        message_id: HexBinary;
        refund_address: string;
      };
    }
  | {
      claim: {};
    };
export type OwnableMsg =
  | {
      init_ownership_transfer: {
        next_owner: string;
      };
    }
  | {
      revoke_ownership_transfer: {};
    }
  | {
      claim_ownership: {};
    };
export type RouterMsgForAddr =
  | {
      set_route: {
        set: DomainRouteSetForAddr;
      };
    }
  | {
      set_routes: {
        set: DomainRouteSetForAddr[];
      };
    };
export type Addr = string;
export type HexBinary = string;
export type Uint256 = string;
export interface DomainRouteSetForAddr {
  domain: number;
  route?: Addr | null;
}
export interface PostDispatchMsg {
  message: HexBinary;
  metadata: HexBinary;
}
export type QueryMsg =
  | {
      ownable: OwnableQueryMsg;
    }
  | {
      hook: HookQueryMsg;
    }
  | {
      router: RouterQueryForAddr;
    }
  | {
      oracle: IgpGasOracleQueryMsg;
    }
  | {
      igp: IgpQueryMsg;
    };
export type OwnableQueryMsg =
  | {
      get_owner: {};
    }
  | {
      get_pending_owner: {};
    };
export type HookQueryMsg =
  | {
      quote_dispatch: QuoteDispatchMsg;
    }
  | {
      mailbox: {};
    };
export type RouterQueryForAddr =
  | {
      domains: {};
    }
  | {
      get_route: {
        domain: number;
      };
    }
  | {
      list_routes: {
        limit?: number | null;
        offset?: number | null;
        order?: Order | null;
      };
    };
export type Order = 'asc' | 'desc';
export type IgpGasOracleQueryMsg = {
  get_exchange_rate_and_gas_price: {
    dest_domain: number;
  };
};
export type IgpQueryMsg =
  | {
      beneficiary: {};
    }
  | {
      quote_gas_payment: {
        dest_domain: number;
        gas_amount: Uint256;
      };
    };
export interface QuoteDispatchMsg {
  message: HexBinary;
  metadata: HexBinary;
}
export interface BeneficiaryResponse {
  beneficiary: string;
}
export interface DomainsResponse {
  domains: number[];
}
export type Uint128 = string;
export interface GetExchangeRateAndGasPriceResponse {
  exchange_rate: Uint128;
  gas_price: Uint128;
}
export interface OwnerResponse {
  owner: Addr;
}
export interface PendingOwnerResponse {
  pending_owner?: Addr | null;
}
export interface RouteResponseForAddr {
  route: DomainRouteSetForAddr;
}
export interface RoutesResponseForAddr {
  routes: DomainRouteSetForAddr[];
}
export interface MailboxResponse {
  mailbox: string;
}
export interface Empty {
  [k: string]: unknown;
}
export interface QuoteDispatchResponse {
  gas_amount?: Coin | null;
}
export interface Coin {
  amount: Uint128;
  denom: string;
  [k: string]: unknown;
}
export interface QuoteGasPaymentResponse {
  gas_needed: Uint256;
}
