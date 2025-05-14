export const ABI = [
  {
    type: 'impl',
    name: 'UpgradeableImpl',
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
    name: 'HypeErc20Vault',
    interface_name: 'token::extensions::hyp_erc20_vault::IHypErc20Vault',
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
    name: 'token::extensions::hyp_erc20_vault::IHypErc20Vault',
    items: [
      {
        type: 'function',
        name: 'assets_to_shares',
        inputs: [
          {
            name: 'amount',
            type: 'core::integer::u256',
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
        name: 'shares_to_assets',
        inputs: [
          {
            name: 'shares',
            type: 'core::integer::u256',
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
        name: 'share_balance_of',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
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
        name: 'get_precision',
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
        name: 'get_collateral_domain',
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
        name: 'get_exchange_rate',
        inputs: [],
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
    name: 'ERC20VaultImpl',
    interface_name: 'openzeppelin_token::erc20::interface::IERC20',
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
    name: 'openzeppelin_token::erc20::interface::IERC20',
    items: [
      {
        type: 'function',
        name: 'total_supply',
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
        name: 'balance_of',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
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
        name: 'allowance',
        inputs: [
          {
            name: 'owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'spender',
            type: 'core::starknet::contract_address::ContractAddress',
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
        name: 'transfer',
        inputs: [
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
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
        name: 'transfer_from',
        inputs: [
          {
            name: 'sender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
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
        name: 'approve',
        inputs: [
          {
            name: 'spender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
      },
    ],
  },
  {
    type: 'impl',
    name: 'ERC20VaultCamelOnlyImpl',
    interface_name: 'openzeppelin_token::erc20::interface::IERC20CamelOnly',
  },
  {
    type: 'interface',
    name: 'openzeppelin_token::erc20::interface::IERC20CamelOnly',
    items: [
      {
        type: 'function',
        name: 'totalSupply',
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
        name: 'balanceOf',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
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
        name: 'transferFrom',
        inputs: [
          {
            name: 'sender',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'recipient',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'amount',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::bool',
          },
        ],
        state_mutability: 'external',
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
    type: 'impl',
    name: 'MailboxClientImpl',
    interface_name: 'contracts::interfaces::IMailboxClient',
  },
  {
    type: 'interface',
    name: 'contracts::interfaces::IMailboxClient',
    items: [
      {
        type: 'function',
        name: 'set_hook',
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
        name: 'set_interchain_security_module',
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
        name: 'get_hook',
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
        name: 'interchain_security_module',
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
        name: '_is_latest_dispatched',
        inputs: [
          {
            name: '_id',
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
        name: '_is_delivered',
        inputs: [
          {
            name: '_id',
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
        name: 'mailbox',
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
    type: 'impl',
    name: 'RouterImpl',
    interface_name: 'contracts::client::router_component::IRouter',
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
    name: 'contracts::client::router_component::IRouter',
    items: [
      {
        type: 'function',
        name: 'enroll_remote_router',
        inputs: [
          {
            name: 'domain',
            type: 'core::integer::u32',
          },
          {
            name: 'router',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'enroll_remote_routers',
        inputs: [
          {
            name: 'domains',
            type: 'core::array::Array::<core::integer::u32>',
          },
          {
            name: 'addresses',
            type: 'core::array::Array::<core::integer::u256>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'unenroll_remote_router',
        inputs: [
          {
            name: 'domain',
            type: 'core::integer::u32',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'unenroll_remote_routers',
        inputs: [
          {
            name: 'domains',
            type: 'core::array::Array::<core::integer::u32>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'handle',
        inputs: [
          {
            name: 'origin',
            type: 'core::integer::u32',
          },
          {
            name: 'sender',
            type: 'core::integer::u256',
          },
          {
            name: 'message',
            type: 'alexandria_bytes::bytes::Bytes',
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
            type: 'core::array::Array::<core::integer::u32>',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'routers',
        inputs: [
          {
            name: 'domain',
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
    ],
  },
  {
    type: 'impl',
    name: 'GasRouterImpl',
    interface_name: 'contracts::client::gas_router_component::IGasRouter',
  },
  {
    type: 'struct',
    name: 'contracts::client::gas_router_component::GasRouterComponent::GasRouterConfig',
    members: [
      {
        name: 'domain',
        type: 'core::integer::u32',
      },
      {
        name: 'gas',
        type: 'core::integer::u256',
      },
    ],
  },
  {
    type: 'enum',
    name: 'core::option::Option::<core::array::Array::<contracts::client::gas_router_component::GasRouterComponent::GasRouterConfig>>',
    variants: [
      {
        name: 'Some',
        type: 'core::array::Array::<contracts::client::gas_router_component::GasRouterComponent::GasRouterConfig>',
      },
      {
        name: 'None',
        type: '()',
      },
    ],
  },
  {
    type: 'enum',
    name: 'core::option::Option::<core::integer::u32>',
    variants: [
      {
        name: 'Some',
        type: 'core::integer::u32',
      },
      {
        name: 'None',
        type: '()',
      },
    ],
  },
  {
    type: 'enum',
    name: 'core::option::Option::<core::integer::u256>',
    variants: [
      {
        name: 'Some',
        type: 'core::integer::u256',
      },
      {
        name: 'None',
        type: '()',
      },
    ],
  },
  {
    type: 'interface',
    name: 'contracts::client::gas_router_component::IGasRouter',
    items: [
      {
        type: 'function',
        name: 'set_destination_gas',
        inputs: [
          {
            name: 'gas_configs',
            type: 'core::option::Option::<core::array::Array::<contracts::client::gas_router_component::GasRouterComponent::GasRouterConfig>>',
          },
          {
            name: 'domain',
            type: 'core::option::Option::<core::integer::u32>',
          },
          {
            name: 'gas',
            type: 'core::option::Option::<core::integer::u256>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'destination_gas',
        inputs: [
          {
            name: 'destination_domain',
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
        name: 'quote_gas_payment',
        inputs: [
          {
            name: 'destination_domain',
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
    ],
  },
  {
    type: 'impl',
    name: 'TokenRouterImpl',
    interface_name: 'token::components::token_router::ITokenRouter',
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
    type: 'interface',
    name: 'token::components::token_router::ITokenRouter',
    items: [
      {
        type: 'function',
        name: 'transfer_remote',
        inputs: [
          {
            name: 'destination',
            type: 'core::integer::u32',
          },
          {
            name: 'recipient',
            type: 'core::integer::u256',
          },
          {
            name: 'amount_or_id',
            type: 'core::integer::u256',
          },
          {
            name: 'value',
            type: 'core::integer::u256',
          },
          {
            name: 'hook_metadata',
            type: 'core::option::Option::<alexandria_bytes::bytes::Bytes>',
          },
          {
            name: 'hook',
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
    ],
  },
  {
    type: 'impl',
    name: 'HypErc20MetadataImpl',
    interface_name: 'openzeppelin_token::erc20::interface::IERC20Metadata',
  },
  {
    type: 'struct',
    name: 'core::byte_array::ByteArray',
    members: [
      {
        name: 'data',
        type: 'core::array::Array::<core::bytes_31::bytes31>',
      },
      {
        name: 'pending_word',
        type: 'core::felt252',
      },
      {
        name: 'pending_word_len',
        type: 'core::integer::u32',
      },
    ],
  },
  {
    type: 'interface',
    name: 'openzeppelin_token::erc20::interface::IERC20Metadata',
    items: [
      {
        type: 'function',
        name: 'name',
        inputs: [],
        outputs: [
          {
            type: 'core::byte_array::ByteArray',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'symbol',
        inputs: [],
        outputs: [
          {
            type: 'core::byte_array::ByteArray',
          },
        ],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'decimals',
        inputs: [],
        outputs: [
          {
            type: 'core::integer::u8',
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
        name: 'decimals',
        type: 'core::integer::u8',
      },
      {
        name: 'mailbox',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'total_supply',
        type: 'core::integer::u256',
      },
      {
        name: 'name',
        type: 'core::byte_array::ByteArray',
      },
      {
        name: 'symbol',
        type: 'core::byte_array::ByteArray',
      },
      {
        name: 'collateral_domain',
        type: 'core::integer::u32',
      },
      {
        name: 'wrapped_token',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'hook',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'interchain_security_module',
        type: 'core::starknet::contract_address::ContractAddress',
      },
    ],
  },
  {
    type: 'event',
    name: 'token::components::hyp_erc20_component::HypErc20Component::Event',
    kind: 'enum',
    variants: [],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Transfer',
    kind: 'struct',
    members: [
      {
        name: 'from',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'to',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'value',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Approval',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'spender',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'value',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc20::erc20::ERC20Component::Event',
    kind: 'enum',
    variants: [
      {
        name: 'Transfer',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Transfer',
        kind: 'nested',
      },
      {
        name: 'Approval',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Approval',
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
    name: 'contracts::client::gas_router_component::GasRouterComponent::Event',
    kind: 'enum',
    variants: [],
  },
  {
    type: 'event',
    name: 'contracts::client::router_component::RouterComponent::Event',
    kind: 'enum',
    variants: [],
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
    name: 'token::components::token_router::TokenRouterComponent::SentTransferRemote',
    kind: 'struct',
    members: [
      {
        name: 'destination',
        type: 'core::integer::u32',
        kind: 'key',
      },
      {
        name: 'recipient',
        type: 'core::integer::u256',
        kind: 'key',
      },
      {
        name: 'amount',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'token::components::token_router::TokenRouterComponent::ReceivedTransferRemote',
    kind: 'struct',
    members: [
      {
        name: 'origin',
        type: 'core::integer::u32',
        kind: 'key',
      },
      {
        name: 'recipient',
        type: 'core::integer::u256',
        kind: 'key',
      },
      {
        name: 'amount',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'token::components::token_router::TokenRouterComponent::Event',
    kind: 'enum',
    variants: [
      {
        name: 'SentTransferRemote',
        type: 'token::components::token_router::TokenRouterComponent::SentTransferRemote',
        kind: 'nested',
      },
      {
        name: 'ReceivedTransferRemote',
        type: 'token::components::token_router::TokenRouterComponent::ReceivedTransferRemote',
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
    name: 'token::extensions::hyp_erc20_vault::HypErc20Vault::Event',
    kind: 'enum',
    variants: [
      {
        name: 'HypErc20Event',
        type: 'token::components::hyp_erc20_component::HypErc20Component::Event',
        kind: 'flat',
      },
      {
        name: 'ERC20Event',
        type: 'openzeppelin_token::erc20::erc20::ERC20Component::Event',
        kind: 'flat',
      },
      {
        name: 'MailBoxClientEvent',
        type: 'contracts::client::mailboxclient_component::MailboxclientComponent::Event',
        kind: 'flat',
      },
      {
        name: 'GasRouterEvent',
        type: 'contracts::client::gas_router_component::GasRouterComponent::Event',
        kind: 'flat',
      },
      {
        name: 'RouterEvent',
        type: 'contracts::client::router_component::RouterComponent::Event',
        kind: 'flat',
      },
      {
        name: 'OwnableEvent',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::Event',
        kind: 'flat',
      },
      {
        name: 'TokenRouterEvent',
        type: 'token::components::token_router::TokenRouterComponent::Event',
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
