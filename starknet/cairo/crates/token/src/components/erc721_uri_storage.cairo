#[starknet::interface]
pub trait IERC721URIStorage<TContractState> {
    fn name(self: @TContractState) -> ByteArray;
    fn symbol(self: @TContractState) -> ByteArray;
    fn token_uri(self: @TContractState, token_id: u256) -> ByteArray;
}

#[starknet::component]
pub mod ERC721URIStorageComponent {
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc721::interface::IERC721Metadata;
    use openzeppelin::token::erc721::{
        ERC721Component, ERC721Component::InternalTrait as ERC721InternalTrait,
        ERC721Component::ERC721HooksTrait, ERC721Component::ERC721MetadataImpl
    };

    #[storage]
    struct Storage {
        token_uris: LegacyMap<u256, ByteArray>
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        MetadataUpdate: MetadataUpdate,
    }

    #[derive(Drop, starknet::Event)]
    struct MetadataUpdate {
        token_id: u256,
    }

    #[embeddable_as(ERC721URIStorageImpl)]
    pub impl ERC721URIStorage<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +SRC5Component::HasComponent<TContractState>,
        +ERC721HooksTrait<TContractState>,
        impl ERC721: ERC721Component::HasComponent<TContractState>,
    > of super::IERC721URIStorage<ComponentState<TContractState>> {
        // returns the NFT name
        fn name(self: @ComponentState<TContractState>) -> ByteArray {
            let erc721_component = get_dep_component!(self, ERC721);
            erc721_component.name()
        }

        // returns the NFT symbol
        fn symbol(self: @ComponentState<TContractState>) -> ByteArray {
            let erc721_component = get_dep_component!(self, ERC721);
            erc721_component.symbol()
        }

        /// Returns the URI associated with a given `token_id`.
        ///
        /// This function retrieves the URI for an ERC721 token based on its `token_id`. 
        /// It first ensures that the token is owned by the caller, then checks the token-specific URI.
        /// If the token has no specific URI, it appends the token's base URI if one exists.
        ///
        /// # Arguments
        ///
        /// * `token_id` - A `u256` representing the ID of the token whose URI is being queried.
        ///
        /// # Returns
        ///
        /// A `ByteArray` representing the URI associated with the token. If a specific URI is not found, 
        /// it may return the base URI or the token's metadata URI.
        fn token_uri(self: @ComponentState<TContractState>, token_id: u256) -> ByteArray {
            let erc721_component = get_dep_component!(self, ERC721);
            erc721_component._require_owned(token_id);

            let token_uri = self.token_uris.read(token_id);
            let mut base = erc721_component._base_uri();

            if base.len() == 0 {
                return token_uri;
            }

            if token_uri.len() > 0 {
                base.append(@token_uri);
                return base;
            }

            erc721_component.token_uri(token_id)
        }
    }

    #[generate_trait]
    pub impl ERC721URIStorageInternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +SRC5Component::HasComponent<TContractState>,
        +ERC721HooksTrait<TContractState>,
        +ERC721Component::HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        // Sets the URI for a specific `token_id`.
        ///
        /// This internal function allows setting a URI for an ERC721 token. After setting the URI, 
        /// it emits a `MetadataUpdate` event to indicate that the token's metadata has been updated.
        ///
        /// # Arguments
        ///
        /// * `token_id` - A `u256` representing the ID of the token whose URI is being set.
        /// * `token_uri` - A `ByteArray` representing the new URI for the token.
        ///
        /// # Emits
        ///
        /// Emits a `MetadataUpdate` event once the token URI has been updated.
        fn _set_token_uri(
            ref self: ComponentState<TContractState>, token_id: u256, token_uri: ByteArray
        ) {
            self.token_uris.write(token_id, token_uri);
            self.emit(MetadataUpdate { token_id });
        }
    }
}
