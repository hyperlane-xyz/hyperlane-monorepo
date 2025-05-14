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
    name: 'IMailboxImpl',
    interface_name: 'contracts::interfaces::IMailbox',
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
    name: 'core::option::Option::<alexandria_bytes::bytes::Bytes>',
    variants: [
      {
        name: 'Some',
        type: 'alexandria_bytes::bytes::Bytes',
      },
      {
        name: 'None',
        type: '()',
      },
    ],
  },
  {
    type: 'enum',
    name: 'core::option::Option::<core::starknet::contract_address::ContractAddress>',
    variants: [
      {
        name: 'Some',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'None',
        type: '()',
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
    name: 'contracts::interfaces::IMailbox',
    items: [
      {
        type: 'function',
        name: 'get_local_domain',
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
        name: 'delivered',
        inputs: [
          {
            name: '_message_id',
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
        name: 'nonce',
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
        name: 'get_default_ism',
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
        name: 'get_default_hook',
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
        name: 'get_required_hook',
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
        name: 'get_latest_dispatched_id',
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
        name: 'dispatch',
        inputs: [
          {
            name: '_destination_domain',
            type: 'core::integer::u32',
          },
          {
            name: '_recipient_address',
            type: 'core::integer::u256',
          },
          {
            name: '_message_body',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: '_fee_amount',
            type: 'core::integer::u256',
          },
          {
            name: '_custom_hook_metadata',
            type: 'core::option::Option::<alexandria_bytes::bytes::Bytes>',
          },
          {
            name: '_custom_hook',
            type: 'core::option::Option::<core::starknet::contract_address::ContractAddress>',
          },
        ],
        outputs: [
          {
            type: 'core::integer::u256',
          },
        ],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'quote_dispatch',
        inputs: [
          {
            name: '_destination_domain',
            type: 'core::integer::u32',
          },
          {
            name: '_recipient_address',
            type: 'core::integer::u256',
          },
          {
            name: '_message_body',
            type: 'alexandria_bytes::bytes::Bytes',
          },
          {
            name: '_custom_hook_metadata',
            type: 'core::option::Option::<alexandria_bytes::bytes::Bytes>',
          },
          {
            name: '_custom_hook',
            type: 'core::option::Option::<core::starknet::contract_address::ContractAddress>',
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
        name: 'process',
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
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'recipient_ism',
        inputs: [
          {
            name: '_recipient',
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
        name: 'set_default_ism',
        inputs: [
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
        name: 'set_default_hook',
        inputs: [
          {
            name: '_hook',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'set_required_hook',
        inputs: [
          {
            name: '_hook',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'processor',
        inputs: [
          {
            name: '_id',
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
        name: 'processed_at',
        inputs: [
          {
            name: '_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::integer::u64',
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
        name: '_local_domain',
        type: 'core::integer::u32',
      },
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_default_ism',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_default_hook',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_required_hook',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::DefaultIsmSet',
    kind: 'struct',
    members: [
      {
        name: 'module',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::DefaultHookSet',
    kind: 'struct',
    members: [
      {
        name: 'hook',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::RequiredHookSet',
    kind: 'struct',
    members: [
      {
        name: 'hook',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::Process',
    kind: 'struct',
    members: [
      {
        name: 'origin',
        type: 'core::integer::u32',
        kind: 'data',
      },
      {
        name: 'sender',
        type: 'core::integer::u256',
        kind: 'data',
      },
      {
        name: 'recipient',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::ProcessId',
    kind: 'struct',
    members: [
      {
        name: 'id',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::Dispatch',
    kind: 'struct',
    members: [
      {
        name: 'sender',
        type: 'core::integer::u256',
        kind: 'data',
      },
      {
        name: 'destination_domain',
        type: 'core::integer::u32',
        kind: 'data',
      },
      {
        name: 'recipient_address',
        type: 'core::integer::u256',
        kind: 'data',
      },
      {
        name: 'message',
        type: 'contracts::libs::message::Message',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'contracts::mailbox::mailbox::DispatchId',
    kind: 'struct',
    members: [
      {
        name: 'id',
        type: 'core::integer::u256',
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
    name: 'contracts::mailbox::mailbox::Event',
    kind: 'enum',
    variants: [
      {
        name: 'DefaultIsmSet',
        type: 'contracts::mailbox::mailbox::DefaultIsmSet',
        kind: 'nested',
      },
      {
        name: 'DefaultHookSet',
        type: 'contracts::mailbox::mailbox::DefaultHookSet',
        kind: 'nested',
      },
      {
        name: 'RequiredHookSet',
        type: 'contracts::mailbox::mailbox::RequiredHookSet',
        kind: 'nested',
      },
      {
        name: 'Process',
        type: 'contracts::mailbox::mailbox::Process',
        kind: 'nested',
      },
      {
        name: 'ProcessId',
        type: 'contracts::mailbox::mailbox::ProcessId',
        kind: 'nested',
      },
      {
        name: 'Dispatch',
        type: 'contracts::mailbox::mailbox::Dispatch',
        kind: 'nested',
      },
      {
        name: 'DispatchId',
        type: 'contracts::mailbox::mailbox::DispatchId',
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
    ],
  },
] as const;
