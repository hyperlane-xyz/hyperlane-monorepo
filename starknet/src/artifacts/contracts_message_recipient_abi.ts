export const ABI = [
  {
    type: 'impl',
    name: 'IMessageRecipientImpl',
    interface_name: 'contracts::interfaces::IMessageRecipient',
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
    type: 'interface',
    name: 'contracts::interfaces::IMessageRecipient',
    items: [
      {
        type: 'function',
        name: 'handle',
        inputs: [
          {
            name: '_origin',
            type: 'core::integer::u32',
          },
          {
            name: '_sender',
            type: 'core::integer::u256',
          },
          {
            name: '_message',
            type: 'alexandria_bytes::bytes::Bytes',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'get_origin',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u32',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'get_sender',
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
        name: 'get_message',
        inputs: [],
        outputs: [
          {
            type: 'alexandria_bytes::bytes::Bytes',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'impl',
    name: 'ISpecifiesInterchainSecurityModuleImpl',
    interface_name: 'contracts::interfaces::ISpecifiesInterchainSecurityModule',
  },
  {
    type: 'interface',
    name: 'contracts::interfaces::ISpecifiesInterchainSecurityModule',
    items: [
      {
        type: 'function',
        name: 'interchain_security_module',
        inputs: [],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
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
        name: '_ism',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::message_recipient::message_recipient::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
