/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

/* eslint-disable no-console */
import { ProtocolType } from '@hyperlane-xyz/utils';

import { CosmWasmCoreAdapter } from '../../core/adapters/CosmWasmCoreAdapter';
import {
  QueryMsg as AggregateHookQuery,
  HooksResponse,
} from '../../cw-types/HookAggregate.types';
import {
  BeneficiaryResponse,
  DomainsResponse,
  GetExchangeRateAndGasPriceResponse,
  QueryMsg as IgpQuery,
} from '../../cw-types/Igp.types';
import {
  EnrolledValidatorsResponse,
  QueryMsg as MultisigQuery,
} from '../../cw-types/IsmMultisig.types';
import { ChainMetadata } from '../../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';

const neutron: ChainMetadata = {
  protocol: ProtocolType.Cosmos,
  name: 'neutron',
  chainId: 'neutron-1',
  displayName: 'Neutron',
  domainId: 1853125230,
  bech32Prefix: 'neutron',
  slip44: 118,
  rpcUrls: [
    { http: 'https://rpc-kralum.neutron-1.neutron.org' },
    { http: 'grpc-kralum.neutron-1.neutron.org:80' },
  ],
  nativeToken: {
    name: 'Neutron',
    symbol: 'NTRN',
    decimals: 6,
  },
};

const neutronAddresses = {
  mailbox: 'neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4',
};

const mantaDomain = 169;

async function main() {
  const multiProtocolProvider = new MultiProtocolProvider({
    neutron,
  });

  const adapter = new CosmWasmCoreAdapter(
    neutron.name,
    multiProtocolProvider,
    neutronAddresses,
  );

  const provider = await adapter.getProvider();

  // const defaultHook = await adapter.defaultHook();
  const requiredHook = await adapter.requiredHook();
  const requiredHookContract = await provider.getContract(requiredHook);

  // const defaultHookContract = await provider.getContract(defaultHook);

  if (requiredHookContract.label === 'hpl_hook_aggregate') {
    const hooksQuery: AggregateHookQuery = {
      aggregate_hook: {
        hooks: {},
      },
    };
    const resp: HooksResponse = await provider.queryContractSmart(
      requiredHook,
      hooksQuery,
    );
    for (const hook of resp.hooks) {
      const hookContract = await provider.getContract(hook);
      console.log({ hookContract });
      if (hookContract.label === 'hpl_igp') {
        const beneficiaryQuery: IgpQuery = {
          igp: {
            beneficiary: {},
          },
        };
        const beneficiaryResponse: BeneficiaryResponse =
          await provider.queryContractSmart(hook, beneficiaryQuery);
        console.log(beneficiaryResponse);

        const domainsQuery: IgpQuery = {
          router: {
            domains: {},
          },
        };
        const domainsResponse: DomainsResponse =
          await provider.queryContractSmart(hook, domainsQuery);
        for (const domain of domainsResponse.domains) {
          const oracleQuery: IgpQuery = {
            oracle: {
              get_exchange_rate_and_gas_price: {
                dest_domain: domain,
              },
            },
          };
          const oracleResponse: GetExchangeRateAndGasPriceResponse =
            await provider.queryContractSmart(hook, oracleQuery);
          console.log({ domain, oracleResponse });
        }
      }
    }
  }

  const defaultIsm = await adapter.defaultIsm();
  const defaultIsmContract = await provider.getContract(defaultIsm);

  if (defaultIsmContract.label === 'hpl_ism_multisig') {
    const validatorsQuery: MultisigQuery = {
      multisig_ism: {
        enrolled_validators: {
          domain: mantaDomain,
        },
      },
    };
    const resp: EnrolledValidatorsResponse = await provider.queryContractSmart(
      defaultIsm,
      validatorsQuery,
    );
    console.log(resp);
  }

  // console.log({
  //   owner,
  //   defaultHook,
  //   defaultHookContract,
  //   defaultIsm,
  //   defaultIsmContract,
  //   requiredHook,
  //   requiredHookContract,
  //   nonce,
  // });
}

main().catch(console.error);
