export const ABI = [
  {
    type: 'impl',
    name: 'IMerklerootMultisigIsmImpl',
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
    type: 'impl',
    name: 'IValidatorConfigurationImpl',
    interface_name: 'contracts::interfaces::IValidatorConfiguration',
  },
  {
    type: 'struct',
    name: 'core::starknet::eth_address::EthAddress',
    members: [
      {
        name: 'address',
        type: 'core::felt252',
      },
    ],
  },
  {
    type: 'struct',
    name: 'core::array::Span::<core::starknet::eth_address::EthAddress>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::starknet::eth_address::EthAddress>',
      },
    ],
  },
  {
    type: 'interface',
    name: 'contracts::interfaces::IValidatorConfiguration',
    items: [
      {
        type: 'function',
        name: 'validators_and_threshold',
        inputs: [
          {
            name: '_message',
            type: 'contracts::libs::message::Message',
          },
        ],
        outputs: [
          {
            type: '(core::array::Span::<core::starknet::eth_address::EthAddress>, core::integer::u32)',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'get_validators',
        inputs: [],
        outputs: [
          {
            type: 'core::array::Span::<core::starknet::eth_address::EthAddress>',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'get_threshold',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u32',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'impl',
    name: 'OwnableImpl',
    interface_name: 'openzeppelin_access::ownable::interface::IOwnable',
  },
  {
    type: 'interface',
    name: 'openzeppelin_access::ownable::interface::IOwnable',
    items: [
      {
        type: 'function',
        name: 'owner',
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
        name: 'transfer_ownership',
        inputs: [
          {
            name: 'new_owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'renounce_ownership',
        inputs: [],
        outputs: [],
        state_mutability: 'external',
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
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: '_owner',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_validators',
        type: 'core::array::Span::<core::felt252>',
      },
      {
        name: '_threshold',
        type: 'core::integer::u32',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_access::ownable::ownable::OwnableComponent::OwnershipTransferred',
    kind: 'struct',
    members: [
      {
        name: 'previous_owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'new_owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_access::ownable::ownable::OwnableComponent::OwnershipTransferStarted',
    kind: 'struct',
    members: [
      {
        name: 'previous_owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'new_owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_access::ownable::ownable::OwnableComponent::Event',
    kind: 'enum',
    variants: [
      {
        name: 'OwnershipTransferred',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::OwnershipTransferred',
        kind: 'nested',
      },
      {
        name: 'OwnershipTransferStarted',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::OwnershipTransferStarted',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::isms::multisig::merkleroot_multisig_ism::merkleroot_multisig_ism::Event',
    kind: 'enum',
    variants: [
      {
        name: 'OwnableEvent',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
