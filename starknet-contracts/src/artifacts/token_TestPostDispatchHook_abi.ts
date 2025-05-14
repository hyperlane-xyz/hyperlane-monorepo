export const ABI = [
  {
    type: 'impl',
    name: 'TestPostDispatchHookImpl',
    interface_name: 'mocks::test_post_dispatch_hook::ITestPostDispatchHook',
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
    name: 'mocks::test_post_dispatch_hook::ITestPostDispatchHook',
    items: [
      {
        type: 'function',
        name: 'hook_type',
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
        name: 'set_fee',
        inputs: [
          {
            name: 'fee',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'message_dispatched',
        inputs: [
          {
            name: 'message_id',
            type: 'core::integer::u256',
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
            name: 'metadata',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: 'message',
            type: 'contracts::libs::message::Message',
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
            name: 'metadata',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: 'message',
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
    name: 'mocks::test_post_dispatch_hook::TestPostDispatchHook::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
