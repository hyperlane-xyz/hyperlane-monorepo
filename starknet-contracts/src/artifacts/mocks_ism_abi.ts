export const ABI = [
  {
    type: 'impl',
    name: 'IMessageidMultisigIsmImpl',
    interface_name: 'contracts::interfaces::IInterchainSecurityModule',
  },
  {
    type: 'enum',
    name: 'contracts::interfaces::ModuleType',
    variants: [
      {
        name: 'UNUSED',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'ROUTING',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'AGGREGATION',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'LEGACY_MULTISIG',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'MERKLE_ROOT_MULTISIG',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'MESSAGE_ID_MULTISIG',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'NULL',
        type: '()',
      },
      {
        name: 'CCIP_READ',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'struct',
    name: 'alexandria_bytes::bytes::Bytes',
    members: [
      {
        name: 'size',
        type: 'core::integer::u32',
      },
      {
        name: 'data',
        type: 'core::array::Array::<core::integer::u128>',
      },
    ],
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
    name: 'contracts::libs::message::Message',
    members: [
      {
        name: 'version',
        type: 'core::integer::u8',
      },
      {
        name: 'nonce',
        type: 'core::integer::u32',
      },
      {
        name: 'origin',
        type: 'core::integer::u32',
      },
      {
        name: 'sender',
        type: 'core::integer::u256',
      },
      {
        name: 'destination',
        type: 'core::integer::u32',
      },
      {
        name: 'recipient',
        type: 'core::integer::u256',
      },
      {
        name: 'body',
        type: 'alexandria_bytes::bytes::Bytes',
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
    name: 'contracts::interfaces::IInterchainSecurityModule',
    items: [
      {
        type: 'function',
        name: 'module_type',
        inputs: [],
        outputs: [
          {
            type: 'contracts::interfaces::ModuleType',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'verify',
        inputs: [
          {
            name: '_metadata',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: '_message',
            type: 'contracts::libs::message::Message',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::ism::ism::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
