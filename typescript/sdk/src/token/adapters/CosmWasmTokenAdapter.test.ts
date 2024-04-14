/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

/* eslint-disable no-console */
import {
  CosmWasmClient,
  ExecuteInstruction,
  SigningCosmWasmClient,
} from '@cosmjs/cosmwasm-stargate';
import { Secp256k1, keccak256 } from '@cosmjs/crypto';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';

import { Address } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata.js';
import { Chains } from '../../consts/chains.js';
import { CosmWasmCoreAdapter } from '../../core/adapters/CosmWasmCoreAdapter.js';
import {
  MailboxResponse,
  QueryMsg as MerkleQuery,
  OwnerResponse,
} from '../../cw-types/HookMerkle.types.js';
import { CosmWasmMultisigAdapter } from '../../ism/adapters/CosmWasmMultisigAdapter.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

const neutronAddresses = {
  mailbox: 'neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4',
  validatorAnnounce:
    'neutron17w4q6efzym3p4c6umyp4cjf2ustjtmwfqdhd7rt2fpcpk9fmjzsq0kj0f8',
};

const neutron = chainMetadata.neutron;
const mantapacific = chainMetadata.mantapacific;

const multiProtocolProvider = new MultiProtocolProvider();

const adapter = new CosmWasmCoreAdapter(
  Chains.neutron,
  multiProtocolProvider,
  neutronAddresses,
);

export async function getSigningClient(pkey: string) {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(pkey, 'hex'),
    neutron.bech32Prefix!,
  );

  const [account] = await wallet.getAccounts();

  const clientBase = await Tendermint37Client.connect(neutron.rpcUrls[0].http);

  const gasPrice = GasPrice.fromString('0.1untrn');

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

const initTransferOwner = (
  address: Address,
  newOwner: Address,
  key = 'ownable',
): ExecuteInstruction => {
  return {
    contractAddress: address,
    msg: {
      [key]: {
        init_ownership_transfer: {
          next_owner: newOwner,
        },
      },
    },
  };
};

const claimTransferOwner = (
  address: Address,
  key = 'ownable',
): ExecuteInstruction => {
  return {
    contractAddress: address,
    msg: {
      [key]: {
        claim_ownership: {},
      },
    },
  };
};

const getOwner = async (
  provider: CosmWasmClient,
  address: Address,
): Promise<Address> => {
  const ownableQuery = {
    ownable: { get_owner: {} },
  };
  const ownerResponse: OwnerResponse = await provider.queryContractSmart(
    address,
    ownableQuery,
  );
  return ownerResponse.owner;
};

export async function rotateHooks() {
  const desiredDefault =
    'neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk';

  const desiredRequired =
    'neutron19qjplhq7jsmk7haneafqxyyhltgllvvag8c4g7jkmxw6mvd4h8sq7rqh02';

  const safe = await getSigningClient(
    '2ac7230628b8b4a587c4005798184735471b9240fc57fc75d97824e1fb6b5409',
  );

  const tx = await safe.wasm.executeMultiple(
    safe.signer,
    [
      adapter.setDefaultHook(desiredDefault),
      adapter.setRequiredHook(desiredRequired),
    ],
    'auto',
  );

  console.log(tx);
}

export async function rotateAuth() {
  const safe = await getSigningClient(
    '2ac7230628b8b4a587c4005798184735471b9240fc57fc75d97824e1fb6b5409',
  );

  const desiredOwner =
    'neutron1fqf5mprg3f5hytvzp3t7spmsum6rjrw80mq8zgkc0h6rxga0dtzqws3uu7';

  const addresses: string[] = [
    'neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4', // mailbox
    'neutron17w4q6efzym3p4c6umyp4cjf2ustjtmwfqdhd7rt2fpcpk9fmjzsq0kj0f8', // validator announce
    'neutron1q75ky8reksqzh0lkhk9k3csvjwv74jjquahrj233xc7dvzz5fv4qtvw0qg', // multisig ISM
    'neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk', // merkle
    'neutron19qjplhq7jsmk7haneafqxyyhltgllvvag8c4g7jkmxw6mvd4h8sq7rqh02', // pausable
    'neutron1ch7x3xgpnj62weyes8vfada35zff6z59kt2psqhnx9gjnt2ttqdqtva3pa', // warp route
  ];

  const transferInstructions: ExecuteInstruction[] = [];
  const claimInstructions: ExecuteInstruction[] = [];

  for (const address of addresses) {
    const info = await safe.wasm.getContract(address);
    console.log({ address, info });
    try {
      await getOwner(safe.wasm, address);

      const transferInstruction = initTransferOwner(address, desiredOwner);
      transferInstructions.push(transferInstruction);

      const claimInstruction = claimTransferOwner(address);
      claimInstructions.push(claimInstruction);
    } catch (e: any) {
      if (e.message.includes('unknown variant `ownable`')) {
        console.log(
          `Skipping ${info.label} (${address}) because it is not ownable`,
        );
      } else {
        throw e;
      }
    }
    // }

    console.log(JSON.stringify({ transferInstructions, claimInstructions }));

    // const tx = await safe.wasm.executeMultiple(
    //   safe.signer,
    //   transferInstructions,
    //   'auto',
    // );
    // console.log(tx);

    // const claimTx = await safe.wasm.execute(
    //   safe.signer,
    //   address,
    //   claimInstruction.msg,
    //   'auto',
    // );
    // console.log(claimTx);

    const res = await safe.wasm.updateAdmin(
      safe.signer,
      address,
      desiredOwner,
      'auto',
    );
    console.log(res);
  }
}

export async function summary() {
  const summary: any = {};

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

  const router =
    'neutron1ch7x3xgpnj62weyes8vfada35zff6z59kt2psqhnx9gjnt2ttqdqtva3pa';
  summary.warproute = {
    owner: await getOwner(router),
    ...(await provider.getContract(router)),
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
  if (requiredHookContract.label === 'hpl_hook_pausable') {
    summary.requiredHook = {
      ...requiredHookContract,
      owner: await getOwner(requiredHook),
      mailbox: await getMailbox(requiredHook),
    };
  }
  //  else if (requiredHookContract.label === 'hpl_hook_aggregate') {
  // const aggregateHookQuery: AggregateQuery = {
  //   aggregate_hook: {
  //     hooks: {},
  //   },
  // };
  // const hooksResponse: HooksResponse = await provider.queryContractSmart(
  //   requiredHook,
  //   aggregateHookQuery,
  // );
  // summary.requiredHook = {
  //   ...requiredHookContract,
  //   hooks: hooksResponse.hooks,
  //   owner: await getOwner(requiredHook),
  //   mailbox: await getMailbox(requiredHook),
  // };

  const defaultHookContract = await provider.getContract(defaultHook);
  if (defaultHookContract.label === 'hpl_hook_merkle') {
    summary.defaultHook = defaultHookContract;
  }

  //   for (const hook of hooksResponse.hooks) {
  // const hook = defaultHook;
  // const hookContract = await provider.getContract(hook);
  // if (hookContract.label === 'hpl_hook_merkle') {
  //   // summary.requiredHook.merkleHook = {
  //   summary.merkleHook = {
  //     ...hookContract,
  //     mailbox: await getMailbox(hook),
  //     owner: await getOwner(hook),
  //   };
  // }
  // } else if (hookContract.label === 'hpl_igp') {
  //   const igpAdapter = new CosmWasmIgpAdapter(
  //     neutron.name,
  //     multiProtocolProvider,
  //     { igp: hook },
  //   );
  //   const oracles = await igpAdapter.getOracles();
  //   const defaultGas = await igpAdapter.defaultGas();
  //   const beneficiary = await igpAdapter.beneficiary();

  //   const mantaData = await igpAdapter.getOracleData(mantapacific.name);
  //   const igpOracle = oracles[mantapacific.name];

  //   summary.requiredHook.igpHook = {
  //     oracles,
  //     mantaOracle: {
  //       ...mantaData,
  //       owner: await getOwner(igpOracle),
  //       ...(await provider.getContract(igpOracle)),
  //     },
  //     defaultGas,
  //     beneficiary,
  //     mailbox: await getMailbox(hook),
  //     owner: await getOwner(hook),
  //     ...hookContract,
  //   };
  // }
  // }

  // console.log(JSON.stringify(summary));
}

export async function rotateValidators() {
  const multisigAdapter = new CosmWasmMultisigAdapter(
    neutron.name,
    multiProtocolProvider,
    {
      multisig:
        'neutron1q75ky8reksqzh0lkhk9k3csvjwv74jjquahrj233xc7dvzz5fv4qtvw0qg',
    },
  );
  const instructions = await multisigAdapter.configureMultisig({
    [mantapacific.name]: {
      threshold: 5,
      validators: [
        '8e668c97ad76d0e28375275c41ece4972ab8a5bc', // hyperlane
        '521a3e6bf8d24809fde1c1fd3494a859a16f132c', // cosmosstation
        '25b9a0961c51e74fd83295293bc029131bf1e05a', // neutron (pablo)
        '14025fe092f5f8a401dd9819704d9072196d2125', // p2p
        'a0ee95e280d46c14921e524b075d0c341e7ad1c8', // cosmos spaces
        'cc9a0b6de7fe314bd99223687d784730a75bb957', // dsrv
        '42b6de2edbaa62c2ea2309ad85d20b3e37d38acf', // sg-1
      ],
    },
  });

  console.log(JSON.stringify(instructions));

  // const safe = await getSigningClient(
  //   '2ac7230628b8b4a587c4005798184735471b9240fc57fc75d97824e1fb6b5409',
  // );

  // const tx = await safe.wasm.executeMultiple(safe.signer, instructions, 'auto');

  // console.log(tx);
}

summary().catch(console.error);
