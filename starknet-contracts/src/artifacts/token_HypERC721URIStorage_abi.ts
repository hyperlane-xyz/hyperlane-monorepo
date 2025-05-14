export const ABI = [
  {
    type: 'impl',
    name: 'HypErc721Upgradeable',
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
    name: 'ERC721URIStorageImpl',
    interface_name: 'token::components::erc721_uri_storage::IERC721URIStorage',
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
    name: 'token::components::erc721_uri_storage::IERC721URIStorage',
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
        name: 'token_uri',
        inputs: [
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [
          {
            type: 'core::byte_array::ByteArray',
          },
        ],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'impl',
    name: 'ERC721Impl',
    interface_name: 'openzeppelin_token::erc721::interface::IERC721',
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
    type: 'interface',
    name: 'openzeppelin_token::erc721::interface::IERC721',
    items: [
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
        name: 'owner_of',
        inputs: [
          {
            name: 'token_id',
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
        name: 'safe_transfer_from',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
          {
            name: 'data',
            type: 'core::array::Span::<core::felt252>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'transfer_from',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'approve',
        inputs: [
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'token_id',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'set_approval_for_all',
        inputs: [
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'approved',
            type: 'core::bool',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'get_approved',
        inputs: [
          {
            name: 'token_id',
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
        name: 'is_approved_for_all',
        inputs: [
          {
            name: 'owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
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
    name: 'ERC721CamelOnlyImpl',
    interface_name: 'openzeppelin_token::erc721::interface::IERC721CamelOnly',
  },
  {
    type: 'interface',
    name: 'openzeppelin_token::erc721::interface::IERC721CamelOnly',
    items: [
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
        name: 'ownerOf',
        inputs: [
          {
            name: 'tokenId',
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
        name: 'safeTransferFrom',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'tokenId',
            type: 'core::integer::u256',
          },
          {
            name: 'data',
            type: 'core::array::Span::<core::felt252>',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'transferFrom',
        inputs: [
          {
            name: 'from',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'to',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'tokenId',
            type: 'core::integer::u256',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'setApprovalForAll',
        inputs: [
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'approved',
            type: 'core::bool',
          },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'getApproved',
        inputs: [
          {
            name: 'tokenId',
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
        name: 'isApprovedForAll',
        inputs: [
          {
            name: 'owner',
            type: 'core::starknet::contract_address::ContractAddress',
          },
          {
            name: 'operator',
            type: 'core::starknet::contract_address::ContractAddress',
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
    type: 'constructor',
    name: 'constructor',
    inputs: [
      {
        name: 'mailbox',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_mint_amount',
        type: 'core::integer::u256',
      },
      {
        name: '_name',
        type: 'core::byte_array::ByteArray',
      },
      {
        name: '_symbol',
        type: 'core::byte_array::ByteArray',
      },
      {
        name: '_hook',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: '_interchainSecurityModule',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'owner',
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
    name: 'contracts::client::mailboxclient_component::MailboxclientComponent::Event',
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
    name: 'contracts::client::gas_router_component::GasRouterComponent::Event',
    kind: 'enum',
    variants: [],
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
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Transfer',
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
        name: 'token_id',
        type: 'core::integer::u256',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Approval',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'approved',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'token_id',
        type: 'core::integer::u256',
        kind: 'key',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::ApprovalForAll',
    kind: 'struct',
    members: [
      {
        name: 'owner',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'operator',
        type: 'core::starknet::contract_address::ContractAddress',
        kind: 'key',
      },
      {
        name: 'approved',
        type: 'core::bool',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_token::erc721::erc721::ERC721Component::Event',
    kind: 'enum',
    variants: [
      {
        name: 'Transfer',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Transfer',
        kind: 'nested',
      },
      {
        name: 'Approval',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Approval',
        kind: 'nested',
      },
      {
        name: 'ApprovalForAll',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::ApprovalForAll',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'openzeppelin_introspection::src5::SRC5Component::Event',
    kind: 'enum',
    variants: [],
  },
  {
    type: 'event',
    name: 'token::components::hyp_erc721_component::HypErc721Component::Event',
    kind: 'enum',
    variants: [],
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
    name: 'token::components::erc721_uri_storage::ERC721URIStorageComponent::MetadataUpdate',
    kind: 'struct',
    members: [
      {
        name: 'token_id',
        type: 'core::integer::u256',
        kind: 'data',
      },
    ],
  },
  {
    type: 'event',
    name: 'token::components::erc721_uri_storage::ERC721URIStorageComponent::Event',
    kind: 'enum',
    variants: [
      {
        name: 'MetadataUpdate',
        type: 'token::components::erc721_uri_storage::ERC721URIStorageComponent::MetadataUpdate',
        kind: 'nested',
      },
    ],
  },
  {
    type: 'event',
    name: 'token::extensions::hyp_erc721_URI_storage::HypERC721URIStorage::Event',
    kind: 'enum',
    variants: [
      {
        name: 'OwnableEvent',
        type: 'openzeppelin_access::ownable::ownable::OwnableComponent::Event',
        kind: 'flat',
      },
      {
        name: 'MailboxclientEvent',
        type: 'contracts::client::mailboxclient_component::MailboxclientComponent::Event',
        kind: 'flat',
      },
      {
        name: 'RouterEvent',
        type: 'contracts::client::router_component::RouterComponent::Event',
        kind: 'flat',
      },
      {
        name: 'GasRouterEvent',
        type: 'contracts::client::gas_router_component::GasRouterComponent::Event',
        kind: 'flat',
      },
      {
        name: 'TokenRouterEvent',
        type: 'token::components::token_router::TokenRouterComponent::Event',
        kind: 'flat',
      },
      {
        name: 'ERC721Event',
        type: 'openzeppelin_token::erc721::erc721::ERC721Component::Event',
        kind: 'flat',
      },
      {
        name: 'SRC5Event',
        type: 'openzeppelin_introspection::src5::SRC5Component::Event',
        kind: 'flat',
      },
      {
        name: 'HypErc721Event',
        type: 'token::components::hyp_erc721_component::HypErc721Component::Event',
        kind: 'flat',
      },
      {
        name: 'UpgradeableEvent',
        type: 'openzeppelin_upgrades::upgradeable::UpgradeableComponent::Event',
        kind: 'flat',
      },
      {
        name: 'ERC721UriStorageEvent',
        type: 'token::components::erc721_uri_storage::ERC721URIStorageComponent::Event',
        kind: 'flat',
      },
    ],
  },
] as const;
