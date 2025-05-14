export const ABI = [
  {
    type: 'impl',
    name: 'Upgradeable',
    interface_name: 'openzeppelin_upgrades::interface::IUpgradeable',
  },
  {
    type: 'interface',
    name: 'openzeppelin_upgrades::interface::IUpgradeable',
    items: [
      {
        type: 'function',
        name: 'upgrade',
        inputs: [
          {
            name: 'new_class_hash',
            type: 'core::starknet::class_hash::ClassHash',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
    ],
  },
  {
    type: 'impl',
    name: 'IDomainRoutingIsmImpl',
    interface_name: 'contracts::interfaces::IDomainRoutingIsm',
  },
  {
    type: 'struct',
    name: 'core::array::Span::<core::integer::u32>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::integer::u32>',
      },
    ],
  },
  {
    type: 'struct',
    name: 'core::array::Span::<core::starknet::contract_address::ContractAddress>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::starknet::contract_address::ContractAddress>',
      },
    ],
  },
  {
    type: 'interface',
    name: 'contracts::interfaces::IDomainRoutingIsm',
    items: [
      {
        type: 'function',
        name: 'initialize',
        inputs: [
          {
            name: '_domains',
            type: 'core::array::Span::<core::integer::u32>',
          },
          {
            name: '_modules',
            type: 'core::array::Span::<core::starknet::contract_address::ContractAddress>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'set',
        inputs: [
          {
            name: '_domain',
            type: 'core::integer::u32',
          },
          {
            name: '_module',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'remove',
        inputs: [
          {
            name: '_domain',
            type: 'core::integer::u32',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'domains',
        inputs: [],
        outputs: [
          {
            type: 'core::array::Span::<core::integer::u32>',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'module',
        inputs: [
          {
            name: '_origin',
            type: 'core::integer::u32',
          },
        ],
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
    type: 'impl',
    name: 'IRoutingIsmImpl',
    interface_name: 'contracts::interfaces::IRoutingIsm',
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
    name: 'contracts::interfaces::IRoutingIsm',
    items: [
      {
        type: 'function',
        name: 'route',
        inputs: [
          {
            name: '_message',
            type: 'contracts::libs::message::Message',
          },
        ],
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
    type: 'impl',
    name: 'IInterchainSecurityModuleImpl',
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
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: '_owner',
        type: 'core::starknet::contract_address::ContractAddress',
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
    name: 'openzeppelin_upgrades::upgradeable::UpgradeableComponent::Upgraded',
    kind: 'struct',
    members: [
      {
        name: 'class_hash',
        type: 'core::starknet::class_hash::ClassHash',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_upgrades::upgradeable::UpgradeableComponent::Event',
    kind: 'enum',
    variants: [
      {
        name: 'Upgraded',
        type: 'openzeppelin_upgrades::upgradeable::UpgradeableComponent::Upgraded',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::isms::routing::domain_routing_ism::domain_routing_ism::Event',
    kind: 'enum',
    variants: [
      {
        name: 'OwnableEvent',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::Event',
        kind: 'flat',
      },
      {
        name: 'UpgradeableEvent',
        type: 'openzeppelin_upgrades::upgradeable::UpgradeableComponent::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
