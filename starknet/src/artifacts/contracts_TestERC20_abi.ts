export const ABI = [
  {
    type: 'impl',
    name: 'ITestERC20',
    interface_name: 'mocks::test_erc20::ITestERC20',
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
    type: 'enum',
    name: 'core::bool',
    variants: [
      {
        name: 'False',
        type: '()',
      },
      {
        name: 'True',
        type: '()',
      },
    ],
  },
  {
    type: 'interface',
    name: 'mocks::test_erc20::ITestERC20',
    items: [
      {
        type: 'function',
        name: 'total_supply',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u256',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'balance_of',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [
          {
            type: 'core::integer::u256',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'allowance',
        inputs: [
          {
            name: 'owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'spender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [
          {
            type: 'core::integer::u256',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'transfer_from',
        inputs: [
          {
            name: 'sender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'approve',
        inputs: [
          {
            name: 'spender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'decimals',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u8',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'mint',
        inputs: [
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'mint_to',
        inputs: [
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'burn_from',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'burn',
        inputs: [
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
    ],
  },
  {
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: 'total_supply',
        type: 'core::integer::u256',
      },
      {
        name: 'decimals',
        type: 'core::integer::u8',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Transfer',
    kind: 'struct',
    members: [
      {
        name: 'from',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'to',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'value',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Approval',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'spender',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'value',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Event',
    kind: 'enum',
    variants: [
      {
        name: 'Transfer',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Transfer',
        kind: 'nested',
      },
      {
        name: 'Approval',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Approval',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::test_erc20::TestERC20::Event',
    kind: 'enum',
    variants: [
      {
        name: 'ERC20Event',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
