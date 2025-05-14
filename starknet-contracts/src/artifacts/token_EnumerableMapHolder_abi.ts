export const ABI = [
  {
    type: 'impl',
    name: 'Holder',
    interface_name: 'mocks::enumerable_map_holder::IEnumerableMapHolder',
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
    name: 'mocks::enumerable_map_holder::IEnumerableMapHolder',
    items: [
      {
        type: 'function',
        name: 'do_get_len',
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
        name: 'do_set_key',
        inputs: [
          {
            name: 'key',
            type: 'core::integer::u32',
          },
          {
            name: 'value',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'do_get_value',
        inputs: [
          {
            name: 'key',
            type: 'core::integer::u32',
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
        name: 'do_contains',
        inputs: [
          {
            name: 'key',
            type: 'core::integer::u32',
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
        name: 'do_remove',
        inputs: [
          {
            name: 'key',
            type: 'core::integer::u32',
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
        name: 'do_at',
        inputs: [
          {
            name: 'index',
            type: 'core::integer::u32',
          },
        ],
        outputs: [
          {
            type: '(core::integer::u32, core::integer::u256)',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'do_get_keys',
        inputs: [],
        outputs: [
          {
            type: 'core::array::Array::<core::integer::u32>',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::enumerable_map_holder::EnumerableMapHolder::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
