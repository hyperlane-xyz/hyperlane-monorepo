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
    name: 'IValidatorAnnonceImpl',
    interface_name: 'contracts::interfaces::IValidatorAnnounce',
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
    type: 'struct',
    name: 'core::array::Span::<core::array::Array::<core::felt252>>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::array::Array::<core::felt252>>',
      },
    ],
  },
  {
    type: 'struct',
    name: 'core::array::Span::<core::array::Span::<core::array::Array::<core::felt252>>>',
    members: [
      {
        name: 'snapshot',
        type: '@core::array::Array::<core::array::Span::<core::array::Array::<core::felt252>>>',
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
    type: 'interface',
    name: 'contracts::interfaces::IValidatorAnnounce',
    items: [
      {
        type: 'function',
        name: 'get_announced_validators',
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
        name: 'get_announced_storage_locations',
        inputs: [
          {
            name: '_validators',
            type: 'core::array::Span::<core::starknet::eth_address::EthAddress>',
          },
        ],
        outputs: [
          {
            type: 'core::array::Span::<core::array::Span::<core::array::Array::<core::felt252>>>',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'announce',
        inputs: [
          {
            name: '_validator',
            type: 'core::starknet::eth_address::EthAddress',
          },
          {
            name: '_storage_location',
            type: 'core::array::Array::<core::felt252>',
          },
          {
            name: '_signature',
            type: 'alexandria_bytes::bytes::Bytes',
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
        name: 'get_announcement_digest',
        inputs: [
          {
            name: '_storage_location',
            type: 'core::array::Array::<core::integer::u256>',
          },
        ],
        outputs: [
          {
            type: 'core::integer::u256',
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
        name: '_mailbox',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_owner',
        type: 'core::starknet::contract_address::ContractAddress',
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
    type: 'event',
    name: 'contracts::isms::multisig::validator_announce::validator_announce::ValidatorAnnouncement',
    kind: 'struct',
    members: [
      {
        name: 'validator',
        type: 'core::starknet::eth_address::EthAddress',
        kind: 'data',
      },
      {
        name: 'storage_location',
        type: 'core::array::Span::<core::felt252>',
        kind: 'data',
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
    name: 'contracts::client::mailboxclient_component::MailboxclientComponent::Event',
    kind: 'enum',
    variants: [],
  },
  {
    type: 'event',
    name: 'contracts::isms::multisig::validator_announce::validator_announce::Event',
    kind: 'enum',
    variants: [
      {
        name: 'ValidatorAnnouncement',
        type: 'contracts::isms::multisig::validator_announce::validator_announce::ValidatorAnnouncement',
        kind: 'nested',
      },
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
      {
        name: 'MailboxclientEvent',
        type: 'contracts::client::mailboxclient_component::MailboxclientComponent::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
