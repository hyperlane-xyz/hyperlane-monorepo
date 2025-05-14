export const ABI = [
  {
    type: 'impl',
    name: 'IMockParadexDexImpl',
    interface_name: 'mocks::mock_paradex_dex::IMockParadexDex',
  },
  {
    type: 'interface',
    name: 'mocks::mock_paradex_dex::IMockParadexDex',
    items: [
      {
        type: 'function',
        name: 'deposit_on_behalf_of',
        inputs: [
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_address',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::felt252',
          },
        ],
        outputs: [
          {
            type: 'core::felt252',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'set_hyperlane_token',
        inputs: [
          {
            name: 'token_address',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'get_token_asset_balance',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_address',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [
          {
            type: 'core::felt252',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'constructor',
    name: 'constructor',
    inputs: [],
  },
  {
    type: 'struct',
    name: 'core::integer::u256',
    members: [
      {
        name: 'low',
        type: 'core::integer::u128',
      },
      {
        name: 'high',
        type: 'core::integer::u128',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::mock_paradex_dex::MockParadexDex::DepositSuccess',
    kind: 'struct',
    members: [
      {
        name: 'token',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'recipient',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
      {
        name: 'amount',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::mock_paradex_dex::MockParadexDex::Event',
    kind: 'enum',
    variants: [
      {
        name: 'DepositSuccess',
        type: 'mocks::mock_paradex_dex::MockParadexDex::DepositSuccess',
        kind: 'nested',
      },
    ],
  },
] as const;
