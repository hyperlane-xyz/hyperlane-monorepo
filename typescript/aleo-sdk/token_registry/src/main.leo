import credits.aleo;

// The 'mtsp' program.
program token_registry.aleo {
  record Token {
    owner: address,
    amount: u128,
    token_id: field,
    external_authorization_required: bool,
    authorized_until: u32
  }

  struct TokenMetadata {
    token_id: field,
    name: u128, // ASCII text represented in bits, and the u128 value of the bitstring
    symbol: u128, // ASCII text represented in bits, and the u128 value of the bitstring
    decimals: u8,
    supply: u128,
    max_supply: u128,
    admin: address,
    external_authorization_required: bool, // whether or not this token requires authorization from an external program before transferring
    external_authorization_party: address
  }

  struct TokenOwner {
    account: address,
    token_id: field
  }

  struct Balance {
    token_id: field,
    account: address,
    balance: u128,
    authorized_until: u32
  }

  struct Allowance {
    account: address,
    spender: address,
    token_id: field
  }

  @custom
  async constructor() {assert(true);}

  const CREDITS_RESERVED_TOKEN_ID: field = 3443843282313283355522573239085696902919850365217539366784739393210722344986field;
  mapping registered_tokens: field => TokenMetadata;
  mapping balances: field => Balance; // hash(token_id, account) => Balance
  mapping authorized_balances: field => Balance; // hash(token_id, account) => Balance
  mapping allowances: field => u128; // hash(token_id, account, spender) => Allowance

  const MINTER_ROLE: u8 = 1u8;
  const BURNER_ROLE: u8 = 2u8;
  const SUPPLY_MANAGER_ROLE: u8 = 3u8;
  mapping roles: field => u8; // hash(token_id, account) => role

  // -------------------------
  // Called by token admins
  // -------------------------

  async transition initialize() -> Future {
    return finalize_initialize();
  }

  async function finalize_initialize() {
    // Check if the CREDITS_RESERVED_TOKEN_ID token has already been initialized
    let already_initialized: bool = registered_tokens.contains(CREDITS_RESERVED_TOKEN_ID);
    assert_eq(already_initialized, false);

    // Initialize the CREDITS_RESERVED_TOKEN_ID token
    let credits_reserved_token: TokenMetadata = TokenMetadata {
      token_id: CREDITS_RESERVED_TOKEN_ID,
      name: 1095517519u128,
      symbol: 1095517519u128,
      decimals: 6u8,
      supply: 0u128, // placeholder value; not used
      max_supply: 10_000_000_000_000_000u128,
      admin: wrapped_credits.aleo, // admin is the token_registry itself, ie no one can change the token metadata
      external_authorization_required: false,
      external_authorization_party: self.address // admin is the token_registry itself, ie no one can change the token metadata
    };

    registered_tokens.set(CREDITS_RESERVED_TOKEN_ID, credits_reserved_token);
  }

  async transition register_token(
    public token_id: field,
    public name: u128,
    public symbol: u128,
    public decimals: u8,
    public max_supply: u128,
    public external_authorization_required: bool,
    public external_authorization_party: address
    ) -> Future {
    assert(token_id != CREDITS_RESERVED_TOKEN_ID);
    let token: TokenMetadata = TokenMetadata {
      token_id: token_id,
      name: name,
      symbol: symbol,
      decimals: decimals,
      supply: 0u128,
      max_supply: max_supply,
      admin: self.caller,
      external_authorization_required: external_authorization_required,
      external_authorization_party: external_authorization_party
    };

    return finalize_register_token(token);
  }

  async function finalize_register_token(token: TokenMetadata) {
    // Make sure token doesn't already exist
    let token_exists: bool = registered_tokens.contains(token.token_id);
    assert_eq(token_exists, false);
    // Set new token
    registered_tokens.set(token.token_id, token);
  }

  async transition update_token_management(
    public token_id: field,
    public admin: address,
    public external_authorization_party: address
  ) -> Future {
    assert(token_id != CREDITS_RESERVED_TOKEN_ID);
    return finalize_update_token_5(token_id, admin, external_authorization_party, self.caller);
  }

  async function finalize_update_token_5(
    token_id: field,
    admin: address,
    external_authorization_party: address,
    caller: address
  ) {
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert_eq(caller, token.admin);

    let new_metadata: TokenMetadata = TokenMetadata {
      token_id: token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      supply: token.supply,
      max_supply: token.max_supply,
      admin: admin,
      external_authorization_required: token.external_authorization_required,
      external_authorization_party: external_authorization_party
    };
    registered_tokens.set(token_id, new_metadata);
  }

  async transition set_role(
    public token_id: field,
    public account: address,
    public role: u8
  ) -> Future {
    assert(token_id != CREDITS_RESERVED_TOKEN_ID);
    assert(role == MINTER_ROLE || role == BURNER_ROLE || role == SUPPLY_MANAGER_ROLE);

    let role_owner: TokenOwner = TokenOwner {
      account: account,
      token_id: token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);

    return finalize_set_role(token_id, role, self.caller, role_owner_hash);
  }

  async function finalize_set_role(
    token_id: field,
    role: u8,
    caller: address,
    role_owner_hash: field
  ) {
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert_eq(caller, token.admin);

    roles.set(role_owner_hash, role);
  }

  async transition remove_role(
    public token_id: field,
    public account: address
  ) -> Future {
    assert(token_id != CREDITS_RESERVED_TOKEN_ID);

    let role_owner: TokenOwner = TokenOwner {
      account: account,
      token_id: token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);

    return finalize_remove_role(token_id, self.caller, role_owner_hash);
  }

  async function finalize_remove_role(
    token_id: field,
    caller: address,
    role_owner_hash: field
  ) {
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert_eq(caller, token.admin);

    roles.remove(role_owner_hash);
  }

  async transition mint_public(
    public token_id: field,
    public recipient: address,
    public amount: u128,
    public authorized_until: u32
  ) -> Future {
    let role_owner: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);
    let token_owner: TokenOwner = TokenOwner {
      account: recipient,
      token_id: token_id
    };
    let balance_key: field = BHP256::hash_to_field(token_owner);

    return finalize_mint_public(token_id, recipient, amount, authorized_until, self.caller, role_owner_hash, balance_key);
  }

  async function finalize_mint_public(
    token_id: field,
    recipient: address,
    amount: u128,
    authorized_until: u32,
    caller: address,
    role_owner_hash: field,
    balance_key: field
  ) {
    // Check that the token exists, and that the caller has permission to mint
    let token: TokenMetadata = registered_tokens.get(token_id);
    let is_admin: bool = caller == token.admin;
    if (!is_admin) {
      let role: u8 = roles.get(role_owner_hash);
      assert(role == MINTER_ROLE || role == SUPPLY_MANAGER_ROLE);
    }

    // Check that the token supply + amount <= max_supply
    let new_supply: u128 = token.supply + amount;
    assert(new_supply <= token.max_supply);

    // Get or create the balance for the recipient
    let default_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: 0u128,
      authorized_until: authorized_until
    };
    let authorization_required: bool = token.external_authorization_required;
    // Get the locked balance if authorization is required, otherwise get the authorized balance
    let balance: Balance = authorization_required
      ? balances.get_or_use(balance_key, default_balance)
      : authorized_balances.get_or_use(balance_key, default_balance);
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: balance.balance + amount,
      authorized_until: balance.authorized_until
    };
    // Update the appropriate balance
    if (authorization_required) {
      balances.set(balance_key, new_balance);
    } else {
      authorized_balances.set(balance_key, new_balance);
    }

    // Update the token supply
    let new_metadata: TokenMetadata = TokenMetadata {
      token_id: token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      supply: new_supply,
      max_supply: token.max_supply,
      admin: token.admin,
      external_authorization_required: token.external_authorization_required,
      external_authorization_party: token.external_authorization_party
    };
    registered_tokens.set(token_id, new_metadata);
  }

  async transition mint_private(
    public token_id: field,
    recipient: address,
    public amount: u128,
    public external_authorization_required: bool,
    public authorized_until: u32
    ) -> (Token, Future) {
    let token: Token = Token {
      owner: recipient,
      amount: amount,
      token_id: token_id,
      external_authorization_required: external_authorization_required,
      authorized_until: authorized_until
    };
    let role_owner: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);

    return (token, finalize_mint_private(token_id, amount, external_authorization_required, authorized_until, self.caller, role_owner_hash));
  }

  async function finalize_mint_private(
    token_id: field,
    amount: u128,
    external_authorization_required: bool,
    authorized_until: u32,
    caller: address,
    role_owner_hash: field
  ) {
    // Check that the token exists, and that the caller has permission to mint
    let token: TokenMetadata = registered_tokens.get(token_id);
    let is_admin: bool = caller == token.admin;
    if (!is_admin) {
      let role: u8 = roles.get(role_owner_hash);
      assert(role == MINTER_ROLE || role == SUPPLY_MANAGER_ROLE);
    }

    // Check that the token supply + amount <= max_supply
    let new_supply: u128 = token.supply + amount;
    assert(new_supply <= token.max_supply);

    // Check that whether the token is authorized or not matches the authorized parameter
    let authorization_required: bool = token.external_authorization_required;
    assert_eq(authorization_required, external_authorization_required);
    assert(authorized_until == 0u32 || !authorization_required);

    // Update the token supply
    let new_metadata: TokenMetadata = TokenMetadata {
      token_id: token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      supply: new_supply,
      max_supply: token.max_supply,
      admin: token.admin,
      external_authorization_required: token.external_authorization_required,
      external_authorization_party: token.external_authorization_party
    };
    registered_tokens.set(token_id, new_metadata);
  }

  async transition burn_public(
    public token_id: field,
    public owner: address,
    public amount: u128
  ) -> Future {
    let token_owner: TokenOwner = TokenOwner {
      account: owner,
      token_id: token_id
    };
    let balance_key: field = BHP256::hash_to_field(token_owner);
    let role_owner: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);

    return finalize_burn_public(token_owner, amount, self.caller, role_owner_hash, balance_key);
  }

  async function finalize_burn_public(
    owner: TokenOwner,
    amount: u128,
    caller: address,
    role_owner_hash: field,
    balance_key: field
  ) {
    // Check that the token exists, and that the caller has permission to burn
    let token: TokenMetadata = registered_tokens.get(owner.token_id);
    if (caller != token.admin) {
      let role: u8 = roles.get(role_owner_hash);
      assert(role == BURNER_ROLE || role == SUPPLY_MANAGER_ROLE);
    }

    // Update the token supply
    let new_metadata: TokenMetadata = TokenMetadata {
      token_id: token.token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      supply: token.supply - amount, // underflow will be caught by the VM
      max_supply: token.max_supply,
      admin: token.admin,
      external_authorization_required: token.external_authorization_required,
      external_authorization_party: token.external_authorization_party
    };
    registered_tokens.set(owner.token_id, new_metadata);

    // Get the authorized balance for the recipient
    let default_balance: Balance = Balance {
      token_id: owner.token_id,
      account: owner.account,
      balance: 0u128,
      authorized_until: 0u32
    };
    let authorized_balance: Balance = authorized_balances.get_or_use(balance_key, default_balance);
    // Check if the authorized balance is enough to burn
    if (authorized_balance.balance >= 0u128) {
      // Burn from authorized balance
      if (authorized_balance.balance > amount) {
        let new_authorized_balance: Balance = Balance {
          token_id: owner.token_id,
          account: owner.account,
          balance: authorized_balance.balance - amount,
          authorized_until: authorized_balance.authorized_until
        };
        authorized_balances.set(balance_key, new_authorized_balance);
        return; // Done burning
      } else {
        authorized_balances.set(balance_key, Balance {
          token_id: owner.token_id,
          account: owner.account,
          balance: 0u128,
          authorized_until: authorized_balance.authorized_until
        });
        let left_to_burn: u128 = amount - authorized_balance.balance;
        if (left_to_burn == 0u128) {
          return; // Done burning
        } else {
          // Burn remainder from locked balance
          let locked_balance: Balance = balances.get(balance_key);
          let new_locked_balance: Balance = Balance {
            token_id: owner.token_id,
            account: owner.account,
            balance: locked_balance.balance - left_to_burn,
            authorized_until: locked_balance.authorized_until
          };
          balances.set(balance_key, new_locked_balance);
        }
      }
    } else {
      // Otherwise burn directly from locked balance
      let locked_balance: Balance = balances.get(balance_key);
      let new_locked_balance: Balance = Balance {
        token_id: owner.token_id,
        account: owner.account,
        balance: locked_balance.balance - amount,
        authorized_until: locked_balance.authorized_until
      };
      balances.set(balance_key, new_locked_balance);
    }
  }

  async transition burn_private(
    input_record: Token,
    public amount: u128
  ) -> (Token, Future) {
    let output_record: Token = Token {
        owner: input_record.owner,
        amount: input_record.amount - amount,
        token_id: input_record.token_id,
        external_authorization_required: input_record.external_authorization_required,
        authorized_until: input_record.authorized_until
    };
    let role_owner: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: input_record.token_id
    };
    let role_owner_hash: field = BHP256::hash_to_field(role_owner);
    return (output_record, finalize_burn_private(input_record.token_id, amount, self.caller, role_owner_hash));
  }

  async function finalize_burn_private(
    token_id: field,
    amount: u128,
    caller: address,
    role_owner_hash: field
  ) {
    // Check that the token exists, and that the caller has permission to burn
    let token: TokenMetadata = registered_tokens.get(token_id);
    let is_admin: bool = caller == token.admin;
    if (!is_admin) {
      let role: u8 = roles.get(role_owner_hash);
      assert(role == BURNER_ROLE || role == SUPPLY_MANAGER_ROLE);
    }

    // Check that the token supply - amount >= 0
    let new_supply: u128 = token.supply - amount; // underflow will be caught by the VM

    // Update the token supply
    let new_metadata: TokenMetadata = TokenMetadata {
      token_id: token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      supply: new_supply,
      max_supply: token.max_supply,
      admin: token.admin,
      external_authorization_required: token.external_authorization_required,
      external_authorization_party: token.external_authorization_party
    };
    registered_tokens.set(token_id, new_metadata);
  }

  async transition prehook_public(
    public owner: TokenOwner,
    public amount: u128,
    public authorized_until: u32
  ) -> Future {
    let balance_key: field = BHP256::hash_to_field(owner);
    return finalize_prehook_public(owner, amount, authorized_until, self.caller, balance_key);
  }

  async function finalize_prehook_public(
    owner: TokenOwner,
    amount: u128,
    authorized_until: u32,
    caller: address,
    balance_key: field
  ) {
    let token: TokenMetadata = registered_tokens.get(owner.token_id);
    // Check that the token requires external authorization
    assert(token.external_authorization_required);
    // Check that the caller has permission to authorize
    assert(caller == token.external_authorization_party);

    let default_balance: Balance = Balance {
      token_id: owner.token_id,
      account: owner.account,
      balance: 0u128,
      authorized_until: 0u32
    };
    // Get the locked balance for the recipient
    let locked_balance: Balance = balances.get_or_use(balance_key, default_balance);
    // Get the authorized balance for the recipient
    let authorized_balance: Balance = authorized_balances.get_or_use(balance_key, default_balance);
    // Check if the authorized balance is expired
    let authorized_balance_expired: bool = authorized_balance.authorized_until < block.height;
    // If the authorized balance is expired, treat is as part of the locked balance
    let actual_locked_balance: u128 = authorized_balance_expired
      ? locked_balance.balance + authorized_balance.balance
      : locked_balance.balance;
    let actual_authorized_balance: u128 = authorized_balance_expired
      ? 0u128
      : authorized_balance.balance;
    // Move the amount from the locked balance to the authorized balance
    let new_locked_balance: u128 = actual_locked_balance - amount;
    let new_authorized_balance: u128 = actual_authorized_balance + amount;

    // Update the authorized balance with the incremented amount and new expiration
    let new_authorized_balance_struct: Balance = Balance {
      token_id: owner.token_id,
      account: owner.account,
      balance: new_authorized_balance,
      authorized_until: authorized_until
    };
    authorized_balances.set(balance_key, new_authorized_balance_struct);

    // Update the locked balance
    let new_locked_balance_struct: Balance = Balance {
      token_id: owner.token_id,
      account: owner.account,
      balance: new_locked_balance,
      authorized_until: locked_balance.authorized_until
    };
    balances.set(balance_key, new_locked_balance_struct);
  }

  async transition prehook_private(input_record: Token, amount: u128, authorized_until: u32) -> (Token, Token, Future) {
    let unauthorized_record: Token = Token {
        owner: input_record.owner,
        amount: input_record.amount - amount,
        token_id: input_record.token_id,
        external_authorization_required: input_record.external_authorization_required,
        authorized_until: input_record.authorized_until
    };
    let authorized_record: Token = Token {
        owner: input_record.owner,
        amount: amount,
        token_id: input_record.token_id,
        external_authorization_required: input_record.external_authorization_required,
        authorized_until: authorized_until
    };
    return (unauthorized_record, authorized_record, finalize_prehook_private(input_record.token_id, self.caller));
  }

  async function finalize_prehook_private(token_id: field, caller: address) {
    // Check that the caller has permission to authorize
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert(caller == token.external_authorization_party);
  }

  // -------------------------
  // Called by token owners/DeFi contracts
  // -------------------------

  async transition transfer_public(
    public token_id: field,
    public recipient: address,
    public amount: u128
  ) -> Future {
    let sender_key: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: token_id
    };
    let sender_key_hash: field = BHP256::hash_to_field(sender_key);

    let recipient_key: TokenOwner = TokenOwner {
      account: recipient,
      token_id: token_id
    };
    let recipient_balance_key: field = BHP256::hash_to_field(recipient_key);

    return finalize_transfer_public(token_id, recipient, amount, self.caller, sender_key_hash, recipient_balance_key);
  }

  async function finalize_transfer_public(
    token_id: field,
    recipient: address,
    amount: u128,
    owner: address,
    sender_key_hash: field,
    recipient_balance_key: field
  ) {
    let balance: Balance = authorized_balances.get(sender_key_hash);
    // Assert that the balance authorization is not expired or that the token does not require authorization
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert(block.height <= balance.authorized_until || !token.external_authorization_required);
    // Update the balance, and check that the balance >= amount
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: owner,
      balance: balance.balance - amount,
      authorized_until: balance.authorized_until
    };
    // Update sender balance
    authorized_balances.set(sender_key_hash, new_balance);

    // Get the locked balance if authorization is required, otherwise get the authorized balance
    let authorization_required: bool = registered_tokens.get(token_id).external_authorization_required;
    let default_expiration: u32 = authorization_required ? 0u32 : 4294967295u32;
    let default_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: 0u128,
      authorized_until: default_expiration
    };
    let recipient_balance: Balance = authorization_required
      ? balances.get_or_use(recipient_balance_key, default_balance)
      : authorized_balances.get_or_use(recipient_balance_key, default_balance);
    let new_recipient_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: recipient_balance.balance + amount,
      authorized_until: recipient_balance.authorized_until
    };

    // Update recipient balance
    if (authorization_required) {
      balances.set(recipient_balance_key, new_recipient_balance);
    } else {
      authorized_balances.set(recipient_balance_key, new_recipient_balance);
    }
  }

  async transition transfer_public_as_signer(
    public token_id: field,
    public recipient: address,
    public amount: u128
  ) -> Future {
    let sender_key: TokenOwner = TokenOwner {
      account: self.signer,
      token_id: token_id
    };
    let sender_key_hash: field = BHP256::hash_to_field(sender_key);
    let recipient_key: TokenOwner = TokenOwner {
      account: recipient,
      token_id: token_id
    };
    let recipient_balance_key: field = BHP256::hash_to_field(recipient_key);
    return finalize_transfer_public_as_4(token_id, recipient, amount, self.signer, sender_key_hash, recipient_balance_key);
  }

  async function finalize_transfer_public_as_4(
    token_id: field,
    recipient: address,
    amount: u128,
    owner: address,
    sender_key_hash: field,
    recipient_balance_key: field
  ) {
    // Get stored balance for the owner
    let balance: Balance = authorized_balances.get(sender_key_hash);
    // Assert that the balance authorization is not expired or that the token does not require authorization
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert(block.height <= balance.authorized_until || !token.external_authorization_required);
    // Update the balance, and check that the balance >= amount
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: owner,
      balance: balance.balance - amount,
      authorized_until: balance.authorized_until
    };
    // Update sender balance
    authorized_balances.set(sender_key_hash, new_balance);

    // Get the locked balance if authorization is required, otherwise get the authorized balance
    let authorization_required: bool = registered_tokens.get(token_id).external_authorization_required;
    let default_expiration: u32 = authorization_required ? 0u32 : 4294967295u32;
    let default_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: 0u128,
      authorized_until: default_expiration
    };
    let recipient_balance: Balance = authorization_required
      ? balances.get_or_use(recipient_balance_key, default_balance)
      : authorized_balances.get_or_use(recipient_balance_key, default_balance);
    let new_recipient_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: recipient_balance.balance + amount,
      authorized_until: recipient_balance.authorized_until
    };

    // Update recipient balance
    if (authorization_required) {
      balances.set(recipient_balance_key, new_recipient_balance);
    } else {
      authorized_balances.set(recipient_balance_key, new_recipient_balance);
    }
  }

  async transition approve_public(
    public token_id: field,
    public spender: address,
    public amount: u128
  ) -> Future {
    let allowance: Allowance = Allowance {
      account: self.caller,
      spender: spender,
      token_id: token_id
    };
    let allowance_key: field = BHP256::hash_to_field(allowance);

    return finalize_approve_public(amount, allowance_key);
  }

  async function finalize_approve_public(
    amount: u128,
    allowance_key: field
  ) {
    let current_allowance: u128 = allowances.get_or_use(allowance_key, 0u128);
    // Increase or create the allowance amount
    allowances.set(allowance_key, current_allowance + amount);
  }

  async transition unapprove_public(
    public token_id: field,
    public spender: address,
    public amount: u128
  ) -> Future {
    let allowance: Allowance = Allowance {
      account: self.caller,
      spender: spender,
      token_id: token_id
    };
    let allowance_key: field = BHP256::hash_to_field(allowance);

    return finalize_unapprove_public(amount, allowance_key);
  }

  async function finalize_unapprove_public(
    amount: u128,
    allowance_key: field
  ) {
    let current_allowance: u128 = allowances.get(allowance_key);
    // Decrease the allowance amount
    allowances.set(allowance_key, current_allowance - amount);
  }

  async transition transfer_from_public(
    public token_id: field,
    public owner: address,
    public recipient: address,
    public amount: u128
  ) -> Future {
    let allowance: Allowance = Allowance {
      account: owner,
      spender: self.caller,
      token_id: token_id
    };
    let allowance_key: field = BHP256::hash_to_field(allowance);
    let owner_key: TokenOwner = TokenOwner {
      account: owner,
      token_id: token_id
    };
    let owner_key_hash: field = BHP256::hash_to_field(owner_key);

    let recipient_key: TokenOwner = TokenOwner {
      account: recipient,
      token_id: token_id
    };
    let recipient_balance_key: field = BHP256::hash_to_field(recipient_key);

    return finalize_transfer_from_public(token_id, owner, recipient, amount, allowance_key, owner_key_hash, recipient_balance_key);
  }

  async function finalize_transfer_from_public(
    token_id: field,
    owner: address,
    recipient: address,
    amount: u128,
    allowance_key: field,
    owner_key_hash: field,
    recipient_balance_key: field
  ) {
    // Check that the spender is authorized to spend the amount
    let current_allowance: u128 = allowances.get(allowance_key);
    // Decrease the allowance by the amount being spent
    allowances.set(allowance_key, current_allowance - amount);

    // Check that the owner has enough authorized balance
    let balance: Balance = authorized_balances.get(owner_key_hash);
    // Assert that the balance authorization is not expired or that the token does not require authorization
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert(block.height <= balance.authorized_until || !token.external_authorization_required);

    // Update the balance for the owner
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: owner,
      balance: balance.balance - amount,
      authorized_until: balance.authorized_until
    };
    authorized_balances.set(owner_key_hash, new_balance);

    // Get the locked balance if authorization is required, otherwise get the authorized balance
    let authorization_required: bool = registered_tokens.get(token_id).external_authorization_required;
    let default_expiration: u32 = authorization_required ? 0u32 : 4294967295u32;
    let default_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: 0u128,
      authorized_until: default_expiration
    };
    let recipient_balance: Balance = authorization_required
      ? balances.get_or_use(recipient_balance_key, default_balance)
      : authorized_balances.get_or_use(recipient_balance_key, default_balance);
    let new_recipient_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: recipient_balance.balance + amount,
      authorized_until: recipient_balance.authorized_until
    };
    // Update the balance of the recipient
    if (authorization_required) {
      balances.set(recipient_balance_key, new_recipient_balance);
    } else {
      authorized_balances.set(recipient_balance_key, new_recipient_balance);
    }
  }

  async transition transfer_public_to_private(
    public token_id: field,
    recipient: address,
    public amount: u128,
    public external_authorization_required: bool
  ) -> (Token, Future) {
    let authorized_until: u32 = external_authorization_required ? 0u32 : 4294967295u32;
    let token: Token = Token {
      owner: recipient,
      amount: amount,
      token_id: token_id,
      external_authorization_required: external_authorization_required,
      authorized_until: authorized_until
    };

    let sender_key: TokenOwner = TokenOwner {
      account: self.caller,
      token_id: token_id
    };
    let sender_key_hash: field = BHP256::hash_to_field(sender_key);
    return (token, finalize_transfer_public_to_3(token_id, amount, self.caller, external_authorization_required, sender_key_hash));
  }

  async function finalize_transfer_public_to_3(
    token_id: field,
    amount: u128,
    owner: address,
    external_authorization_required: bool,
    sender_key_hash: field
  ) {
    // Check that the transfer record's authorization matches the token's external_authorization_required
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert_eq(token.external_authorization_required, external_authorization_required);

    // Get stored balances for the owner
    let balance: Balance = authorized_balances.get(sender_key_hash);
    // Assert that the balance authorization is not expired or that the token does not require authorization
    let token_metadata: TokenMetadata = registered_tokens.get(token_id);
    assert(block.height <= balance.authorized_until || !token_metadata.external_authorization_required);
    // Update the balance
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: owner,
      balance: balance.balance - amount,
      authorized_until: balance.authorized_until
    };
    authorized_balances.set(sender_key_hash, new_balance);
  }

  async transition transfer_from_public_to_private(
    public token_id: field,
    public owner: address,
    recipient: address,
    public amount: u128,
    public external_authorization_required: bool
  ) -> (Token, Future) {
    let authorized_until: u32 = external_authorization_required ? 0u32 : 4294967295u32;
    let token: Token = Token {
      owner: recipient,
      amount: amount,
      token_id: token_id,
      external_authorization_required: external_authorization_required,
      authorized_until: authorized_until
    };

    let allowance: Allowance = Allowance {
      account: owner,
      spender: self.caller,
      token_id: token_id
    };
    let allowance_key: field = BHP256::hash_to_field(allowance);

    let owner_key: TokenOwner = TokenOwner {
      account: owner,
      token_id: token_id
    };
    let owner_key_hash: field = BHP256::hash_to_field(owner_key);

    return (token, finalize_transfer_from_public_2(token_id, owner, amount, external_authorization_required, allowance_key, owner_key_hash));
  }

  async function finalize_transfer_from_public_2(
    token_id: field,
    owner: address,
    amount: u128,
    external_authorization_required: bool,
    allowance_key: field,
    owner_key_hash: field
  ) {
    // Check that the transfer record's authorization matches the token's external_authorization_required
    let token: TokenMetadata = registered_tokens.get(token_id);
    assert_eq(token.external_authorization_required, external_authorization_required);

    // Check that the spender is authorized to spend the amount
    let current_allowance: u128 = allowances.get(allowance_key);
    // Update the allowance
    allowances.set(allowance_key, current_allowance - amount);

    // Check that the owner has enough authorized balance
    let balance: Balance = authorized_balances.get(owner_key_hash);
    // Assert that the balance authorization is not expired or that the token does not require authorization
    let token_metadata: TokenMetadata = registered_tokens.get(token_id);
    assert(block.height <= balance.authorized_until || !token_metadata.external_authorization_required);
    // Update the balance for the owner
    let new_balance: Balance = Balance {
      token_id: token_id,
      account: owner,
      balance: balance.balance - amount,
      authorized_until: balance.authorized_until
    };
    authorized_balances.set(owner_key_hash, new_balance);
  }

  async transition transfer_private(
    recipient: address,
    amount: u128,
    input_record: Token
  ) -> (Token, Token, Future) {
    let updated_record: Token = Token {
      owner: input_record.owner,
      amount: input_record.amount - amount,
      token_id: input_record.token_id,
      external_authorization_required: input_record.external_authorization_required,
      authorized_until: input_record.authorized_until
    };

    let external_authorization_required: bool = input_record.external_authorization_required;
    let authorized_until: u32 = external_authorization_required ? 0u32 : 4294967295u32;
    let transfer_record: Token = Token {
      owner: recipient,
      amount: amount,
      token_id: input_record.token_id,
      external_authorization_required: external_authorization_required,
      authorized_until: authorized_until
    };

    return (updated_record, transfer_record, finalize_transfer_private(external_authorization_required, input_record.authorized_until));
  }

  async function finalize_transfer_private(
    external_authorization_required: bool,
    input_token_authorized_until: u32
  ) {
    assert(block.height <= input_token_authorized_until || !external_authorization_required);
  }

  async transition transfer_private_to_public(
    public recipient: address,
    public amount: u128,
    input_record: Token
  ) -> (Token, Future) {
    let updated_record: Token = Token {
      owner: input_record.owner,
      amount: input_record.amount - amount,
      token_id: input_record.token_id,
      external_authorization_required: input_record.external_authorization_required,
      authorized_until: input_record.authorized_until
    };

    let recipient_key: TokenOwner = TokenOwner {
      account: recipient,
      token_id: input_record.token_id
    };
    let recipient_balance_key: field = BHP256::hash_to_field(recipient_key);

    return (updated_record,
      finalize_transfer_private_to_1(
        input_record.token_id,
        recipient,
        amount,
        input_record.authorized_until,
        input_record.external_authorization_required,
        recipient_balance_key
    ));
  }

  async function finalize_transfer_private_to_1(
    token_id: field,
    recipient: address,
    amount: u128,
    record_authorized_until: u32,
    external_authorization_required: bool,
    recipient_balance_key: field
  ) {
    // Assert that the record authorization is not expired
    assert(block.height <= record_authorized_until || !external_authorization_required);

    // Get the locked balance if authorization is required, otherwise get the authorized balance
    let authorization_required: bool = registered_tokens.get(token_id).external_authorization_required;
    let default_expiration: u32 = authorization_required ? 0u32 : 4294967295u32;
    let default_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: 0u128,
      authorized_until: default_expiration
    };
    let recipient_balance: Balance = authorization_required
      ? balances.get_or_use(recipient_balance_key, default_balance)
      : authorized_balances.get_or_use(recipient_balance_key, default_balance);
    let new_recipient_balance: Balance = Balance {
      token_id: token_id,
      account: recipient,
      balance: recipient_balance.balance + amount,
      authorized_until: recipient_balance.authorized_until
    };
    // Update the balance of the recipient
    if (authorization_required) {
      balances.set(recipient_balance_key, new_recipient_balance);
    } else {
      authorized_balances.set(recipient_balance_key, new_recipient_balance);
    }
  }

  transition join(
    private token_1: Token,
    private token_2: Token
  ) -> Token {
    // Check that the tokens are the same
    assert(token_1.token_id == token_2.token_id);
    let new_amount: u128 = token_1.amount + token_2.amount;
    // Take the smaller of the two authorized_until values
    let authorized_until: u32 = token_1.authorized_until < token_2.authorized_until
      ? token_1.authorized_until
      : token_2.authorized_until;
    let new_token: Token = Token {
      owner: token_1.owner,
      amount: new_amount,
      token_id: token_1.token_id,
      external_authorization_required: token_1.external_authorization_required,
      authorized_until: authorized_until
    };

    return new_token;
  }

  transition split(
    private token: Token,
    private amount: u128
  ) -> (Token, Token) {
    assert(token.amount >= amount);

    let new_token_1: Token = Token {
      owner: token.owner,
      amount: amount,
      token_id: token.token_id,
      external_authorization_required: token.external_authorization_required,
      authorized_until: token.authorized_until
    };
    let new_token_2: Token = Token {
      owner: token.owner,
      amount: token.amount - amount,
      token_id: token.token_id,
      external_authorization_required: token.external_authorization_required,
      authorized_until: token.authorized_until
    };

    return (new_token_1, new_token_2);
  }
}