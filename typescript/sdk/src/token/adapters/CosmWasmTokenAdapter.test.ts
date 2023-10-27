import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { Secp256k1, keccak256 } from '@cosmjs/crypto';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainMetadata,
  ChainMetadataSchema,
} from '../../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';

import { CwHypNativeTokenAdapter } from './CosmWasmTokenAdapter';

const router =
  'dual1nzkcccxw00u9egqfuuq2ue23hjj6kxmfvmc5y0r7wchk5e6nypns6768kk';

const dualitydevnet: ChainMetadata = {
  name: 'dualitydevnet',
  chainId: 'duality-devnet',
  domainId: 33333,
  protocol: ProtocolType.Cosmos,
  bech32Prefix: 'dual',
  slip44: 118, // what is this
  rpcUrls: [
    {
      http: 'http://54.149.31.83:26657',
    },
  ],
  isTestnet: true,
};

const ibcDenom =
  'ibc/B5CB286F69D48B2C4F6F8D8CF59011C40590DCF8A91617A5FBA9FF0A7B21307F';

const signer = '<PRIVATE_KEY>';

export async function getSigningClient() {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(signer, 'hex'),
    dualitydevnet.bech32Prefix!,
  );

  const [account] = await wallet.getAccounts();

  const clientBase = await Tendermint37Client.connect(
    dualitydevnet.rpcUrls[0].http,
  );

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
  const parsed = ChainMetadataSchema.parse(dualitydevnet);
  console.log({ parsed });
  const multiProtocolProvider = new MultiProtocolProvider({
    dualitydevnet,
  });

  const adapter = new CwHypNativeTokenAdapter(
    dualitydevnet.name,
    multiProtocolProvider,
    { router },
    ibcDenom,
  );
  const owner = await adapter.owner();
  const routers = await adapter.getAllRouters();
  const domains = await adapter.getDomains();
  const balance = await adapter.getBalance(owner);

  console.log({ owner, routers, domains, balance });

  const msg = await adapter.populateTransferRemoteTx({
    destination: domains[0],
    recipient: '0xE000fA4E466831dB288290Dd97e66560fb3d7d28',
    weiAmountOrId: 10,
    txValue: '2500000',
  });

  const client = await getSigningClient();

  const tx = await client.wasm.executeMultiple(client.signer, [msg], 'auto');
  console.log({ tx });
}

main().catch(console.error);
