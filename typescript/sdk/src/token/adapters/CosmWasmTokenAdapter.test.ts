/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

/* eslint-disable no-console */
import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
import { CosmWasmCoreAdapter } from '../../core/adapters/CosmWasmCoreAdapter';
import { CosmWasmIgpAdapter } from '../../core/adapters/CosmWasmIgpAdapter';
import {
  QueryMsg as AggregateQuery,
  HooksResponse,
} from '../../cw-types/HookAggregate.types';
import {
  MailboxResponse,
  QueryMsg as MerkleQuery,
  OwnerResponse,
} from '../../cw-types/HookMerkle.types';
import {
  EnrolledValidatorsResponse,
  ExecuteMsg as MultisigExecute,
  QueryMsg as MultisigQuery,
} from '../../cw-types/IsmMultisig.types';
import { MultisigConfig } from '../../ism/types';
import { ChainMetadata } from '../../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainMap, ChainName } from '../../types';

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

const mantapacific: ChainMetadata = {
  protocol: ProtocolType.Ethereum,
  domainId: 169,
  chainId: 169,
  name: 'mantapacific',
  displayName: 'Manta Pacific',
  displayNameShort: 'Manta',
  nativeToken: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 3,
  },
  rpcUrls: [{ http: 'https://pacific-rpc.manta.network/http' }],
};

const neutronAddresses = {
  mailbox: 'neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4',
  validatorAnnounce:
    'neutron17w4q6efzym3p4c6umyp4cjf2ustjtmwfqdhd7rt2fpcpk9fmjzsq0kj0f8',
};
type MultisigResponse = EnrolledValidatorsResponse;

class CosmWasmMultisigAdapter extends BaseCosmWasmAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { multisig: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryMultisig<R extends MultisigResponse>(
    msg: MultisigQuery,
  ): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.multisig,
      msg,
    );
    return response;
  }

  async getConfig(chain: ChainName): Promise<MultisigConfig> {
    return this.queryMultisig<EnrolledValidatorsResponse>({
      multisig_ism: {
        enrolled_validators: {
          domain: this.multiProvider.getDomainId(chain),
        },
      },
    });
  }

  prepareMultisig(msg: MultisigExecute): ExecuteInstruction {
    return {
      contractAddress: this.addresses.multisig,
      msg,
    };
  }

  async configureMultisig(
    configMap: ChainMap<MultisigConfig>,
  ): Promise<ExecuteInstruction[]> {
    return [
      this.prepareMultisig({
        enroll_validators: {
          set: Object.entries(configMap).flatMap(([origin, config]) =>
            config.validators.map((validator) => ({
              domain: this.multiProvider.getDomainId(origin),
              validator,
            })),
          ),
        },
      }),
      this.prepareMultisig({
        set_thresholds: {
          set: Object.entries(configMap).map(([origin, config]) => ({
            domain: this.multiProvider.getDomainId(origin),
            threshold: config.threshold,
          })),
        },
      }),
    ];
  }
}

async function main() {
  let summary: any = {};

  const multiProtocolProvider = new MultiProtocolProvider({
    neutron,
    mantapacific,
  });

  const adapter = new CosmWasmCoreAdapter(
    neutron.name,
    multiProtocolProvider,
    neutronAddresses,
  );

  const provider = await adapter.getProvider();

  const getOwner = async (address: Address): Promise<Address> => {
    const ownableQuery = {
      ownable: { get_owner: {} },
    };
    const ownerResponse: OwnerResponse = await provider.queryContractSmart(
      address,
      ownableQuery,
    );
    return ownerResponse.owner;
  };

  const owner = await getOwner(neutronAddresses.mailbox);
  const info = await provider.getContract(neutronAddresses.mailbox);
  const defaultHook = await adapter.defaultHook();
  const requiredHook = await adapter.requiredHook();
  const defaultIsm = await adapter.defaultIsm();

  summary.mailbox = {
    owner,
    ...info,
    defaultHook,
    requiredHook,
    defaultIsm,
  };

  summary.validatorAnnounce = {
    // owner: await getOwner(neutronAddresses.validatorAnnounce),
    ...(await provider.getContract(neutronAddresses.validatorAnnounce)),
  };

  const defaultIsmContract = await provider.getContract(defaultIsm);

  if (defaultIsmContract.label === 'hpl_ism_multisig') {
    const multisigAdapter = new CosmWasmMultisigAdapter(
      neutron.name,
      multiProtocolProvider,
      { multisig: defaultIsm },
    );
    const multisigConfig = await multisigAdapter.getConfig(mantapacific.name);
    const owner = await getOwner(defaultIsm);
    summary.defaultIsm = {
      ...multisigConfig,
      ...defaultIsmContract,
      owner,
    };
  }

  const defaultHookContract = await provider.getContract(defaultHook);
  if (defaultHookContract.label === 'hpl_test_mock_hook') {
    summary.defaultHook = defaultHookContract;
  }

  const getMailbox = async (hook: Address): Promise<Address> => {
    const merkleMailboxQuery: MerkleQuery = {
      hook: {
        mailbox: {},
      },
    };
    const merkleMailboxResponse: MailboxResponse =
      await provider.queryContractSmart(hook, merkleMailboxQuery);
    return merkleMailboxResponse.mailbox;
  };

  const requiredHookContract = await provider.getContract(requiredHook);
  if (requiredHookContract.label === 'hpl_hook_aggregate') {
    const aggregateHookQuery: AggregateQuery = {
      aggregate_hook: {
        hooks: {},
      },
    };
    const hooksResponse: HooksResponse = await provider.queryContractSmart(
      requiredHook,
      aggregateHookQuery,
    );
    summary.requiredHook = {
      ...requiredHookContract,
      hooks: hooksResponse.hooks,
      owner: await getOwner(requiredHook),
      mailbox: await getMailbox(requiredHook),
    };

    for (const hook of hooksResponse.hooks) {
      const hookContract = await provider.getContract(hook);
      if (hookContract.label === 'hpl_hook_merkle') {
        summary.requiredHook.merkleHook = {
          ...hookContract,
          mailbox: await getMailbox(hook),
          owner: await getOwner(hook),
        };
      } else if (hookContract.label === 'hpl_igp') {
        const igpAdapter = new CosmWasmIgpAdapter(
          neutron.name,
          multiProtocolProvider,
          { igp: hook },
        );
        const oracles = await igpAdapter.getOracles();
        const defaultGas = await igpAdapter.defaultGas();
        const beneficiary = await igpAdapter.beneficiary();

        const mantaData = await igpAdapter.getOracleData(mantapacific.name);
        const igpOracle = oracles[mantapacific.name];

        summary.requiredHook.igpHook = {
          oracles,
          mantaOracle: {
            ...mantaData,
            owner: await getOwner(igpOracle),
            ...(await provider.getContract(igpOracle)),
          },
          defaultGas,
          beneficiary,
          mailbox: await getMailbox(hook),
          owner: await getOwner(hook),
          ...hookContract,
        };
      }
    }

    console.log(JSON.stringify(summary));
  }
}

main().catch(console.error);
