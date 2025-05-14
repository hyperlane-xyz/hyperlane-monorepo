export const ABI = [
  {
    type: 'impl',
    name: 'IPostDispatchHookImpl',
    interface_name: 'contracts::interfaces::IPostDispatchHook',
  },
  {
    type: 'enum',
    name: 'contracts::interfaces::Types',
    variants: [
      {
        name: 'UNUSED',
        type: '()',
      },
      {
        name: 'ROUTING',
        type: '()',
      },
      {
        name: 'AGGREGATION',
        type: '()',
      },
      {
        name: 'MERKLE_TREE',
        type: '()',
      },
      {
        name: 'INTERCHAIN_GAS_PAYMASTER',
        type: '()',
      },
      {
        name: 'FALLBACK_ROUTING',
        type: '()',
      },
      {
        name: 'ID_AUTH_ISM',
        type: '()',
      },
      {
        name: 'PAUSABLE',
        type: '()',
      },
      {
        name: 'PROTOCOL_FEE',
        type: '()',
      },
      {
        name: 'LAYER_ZERO_V1',
        type: '()',
      },
      {
        name: 'Rate_Limited_Hook',
        type: '()',
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
    type: 'interface',
    name: 'contracts::interfaces::IPostDispatchHook',
    items: [
      {
        type: 'function',
        name: 'hook_type',
        inputs: [],
        outputs: [
          {
            type: 'contracts::interfaces::Types',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'supports_metadata',
        inputs: [
          {
            name: '_metadata',
            type: 'alexandria_bytes::bytes::Bytes',
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
        name: 'post_dispatch',
        inputs: [
          {
            name: '_metadata',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: '_message',
            type: 'contracts::libs::message::Message',
          },
          {
            name: '_fee_amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'quote_dispatch',
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
            type: 'core::integer::u256',
          },
        ],
        state_mutability: 'external',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::fee_hook::fee_hook::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
