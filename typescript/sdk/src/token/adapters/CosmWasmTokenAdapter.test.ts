/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

/* eslint-disable no-console */
import { ProtocolType } from '@hyperlane-xyz/utils';

import { CosmWasmCoreAdapter } from '../../core/adapters/CosmWasmCoreAdapter';
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

async function main() {
  const multiProtocolProvider = new MultiProtocolProvider({
    neutron,
  });

  const adapter = new CosmWasmCoreAdapter(
    neutron.name,
    multiProtocolProvider,
    neutronAddresses,
  );

  const owner = await adapter.owner();
  const defaultHook = await adapter.defaultHook();
  const defaultIsm = await adapter.defaultIsm();
  const requiredHook = await adapter.requiredHook();
  const nonce = await adapter.nonce();

  const provider = await adapter.getProvider();
  const defaultHookContract = await provider.getContract(defaultHook);
  const defaultIsmContract = await provider.getContract(defaultIsm);
  const requiredHookContract = await provider.getContract(requiredHook);

  console.log({
    owner,
    defaultHook,
    defaultHookContract,
    defaultIsm,
    defaultIsmContract,
    requiredHook,
    requiredHookContract,
    nonce,
  });
}

main().catch(console.error);
