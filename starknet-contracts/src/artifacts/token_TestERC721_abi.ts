export const ABI = [
  {
    type: 'impl',
    name: 'TestERC721Impl',
    interface_name: 'mocks::test_erc721::ITestERC721',
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
    type: 'struct',
    name: 'core::array::Span::<core::felt252>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::felt252>',
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
    type: 'struct',
    name: 'core::byte_array::ByteArray',
    members: [
      {
        name: 'data',
        type: 'core::array::Array::<core::bytes_31::bytes31>',
      },
      {
        name: 'pending_word',
        type: 'core::felt252',
      },
      {
        name: 'pending_word_len',
        type: 'core::integer::u32',
      },
    ],
  },
  {
    type: 'interface',
    name: 'mocks::test_erc721::ITestERC721',
    items: [
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
        name: 'owner_of',
        inputs: [
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'safe_transfer_from',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
          {
            name: 'data',
            type: 'core::array::Span::<core::felt252>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'transfer_from',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'approve',
        inputs: [
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'set_approval_for_all',
        inputs: [
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'approved',
            type: 'core::bool',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'get_approved',
        inputs: [
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'is_approved_for_all',
        inputs: [
          {
            name: 'owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'token_uri',
        inputs: [
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::byte_array::ByteArray',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: 'mint_amount',
        type: 'core::integer::u256',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Transfer',
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
        name: 'token_id',
        type: 'core::integer::u256',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Approval',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'approved',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'token_id',
        type: 'core::integer::u256',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::ApprovalForAll',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'operator',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'approved',
        type: 'core::bool',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Event',
    kind: 'enum',
    variants: [
      {
        name: 'Transfer',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Transfer',
        kind: 'nested',
      },
      {
        name: 'Approval',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Approval',
        kind: 'nested',
      },
      {
        name: 'ApprovalForAll',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::ApprovalForAll',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_introspection::src5::SRC5Component::Event',
    kind: 'enum',
    variants: [],
  },
  {
    type: 'event',
    name: 'mocks::test_erc721::TestERC721::Event',
    kind: 'enum',
    variants: [
      {
        name: 'ERC721Event',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Event',
        kind: 'flat',
      },
      {
        name: 'SRC5Event',
        type: 'openzeppelin_introspection::src5::SRC5Component::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
