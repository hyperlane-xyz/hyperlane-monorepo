export const ABI = [
  {
    type: 'impl',
    name: 'IXERC20LockboxTest',
    interface_name: 'mocks::xerc20_lockbox_test::IXERC20LockboxTest',
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
    type: 'interface',
    name: 'mocks::xerc20_lockbox_test::IXERC20LockboxTest',
    items: [
      {
        type: 'function',
        name: 'xerc20',
        inputs: [],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'erc20',
        inputs: [],
        outputs: [
          {
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'deposit_to',
        inputs: [
          {
            name: 'user',
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
        name: 'deposit',
        inputs: [
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
        name: 'withdraw_to',
        inputs: [
          {
            name: 'user',
            type: 'core::integer::u256',
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
        name: 'withdraw',
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
        name: 'xerc20',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'erc20',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'event',
    name: 'mocks::xerc20_lockbox_test::XERC20LockboxTest::Event',
    kind: 'enum',
    variants: [],
  },
] as const;
