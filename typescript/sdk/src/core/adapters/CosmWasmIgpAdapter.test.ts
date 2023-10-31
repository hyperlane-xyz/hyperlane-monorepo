/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

/* eslint-disable no-console */
import {
  ExecuteInstruction,
  SigningCosmWasmClient,
} from '@cosmjs/cosmwasm-stargate';
import { Secp256k1, keccak256 } from '@cosmjs/crypto';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';

import { CosmWasmIgpAdapter } from './CosmWasmIgpAdapter';

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

const signer = '<PRIVATE_KEY>';

export async function getSigningClient() {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(signer, 'hex'),
    neutron.bech32Prefix!,
  );

  const [account] = await wallet.getAccounts();

  const clientBase = await Tendermint37Client.connect(neutron.rpcUrls[0].http);

  const gasPrice = GasPrice.fromString('0.025token');

  const wasm = await SigningCosmWasmClient.createWithSigner(
    clientBase,
    wallet,
    {
      gasPrice,
    },
  );
  const stargate = await SigningStargateClient.createWithSigner(
    clientBase,
    wallet,
    {
      gasPrice,
    },
  );

  const pubkey = Secp256k1.uncompressPubkey(account.pubkey);
  const ethaddr = keccak256(pubkey.slice(1)).slice(-20);

  return {
    wasm,
    stargate,
    signer: account.address,
    signer_addr: Buffer.from(ethaddr).toString('hex'),
    signer_pubkey: Buffer.from(account.pubkey).toString('hex'),
  };
}

async function main() {
  const multiProtocolProvider = new MultiProtocolProvider({
    neutron,
  });

  const adapter = new CosmWasmIgpAdapter(
    neutron.name,
    multiProtocolProvider,
    neutronAddresses,
  );

  const msg: ExecuteInstruction = adapter.prepareSetOracleMsg();

  const client = await getSigningClient();

  const tx = await client.wasm.executeMultiple(client.signer, [msg], 'auto');
  console.log({ tx });
}

main().catch(console.error);
