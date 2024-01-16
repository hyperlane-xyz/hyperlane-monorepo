module hp_mailbox::mailbox {
    use std::vector;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::{SUI};
    use sui::object::{Self, ID, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::pay;
    use sui::event;
    use sui::vec_map::{Self, VecMap};

    use hp_library::merkle_tree::{Self, MerkleTree};
    use hp_library::utils;
    use hp_library::msg_utils;
    use hp_library::h256::{Self, H256};
    use hp_isms::multisig_ism::{Self, ISM};
    use hp_router::router::{Self, RouterCap, RouterRegistry};
    use hp_igps::igps::{Self, IgpState };
    use hp_igps::gas_oracle::{Self, OracleState };

    //
    // Constants
    //

    const NONE_DOMAIN: u32 = 0;
    const MAX_MESSAGE_BODY_BYTES: u64 = 2 * 1024;

    //
    // Errors
    //

    const ERROR_INVALID_OWNER: u64 = 0;
    const ERROR_MSG_LENGTH_OVERFLOW: u64 = 1;
    const ERROR_VERSION_MISMATCH: u64 = 2;
    const ERROR_DOMAIN_MISMATCH: u64 = 3;
    const ERROR_ALREADY_DELIVERED: u64 = 4;
    const ERROR_VERIFY_FAILED: u64 = 5;

    //
    // Events
    //

    struct DispatchEvent has store, drop, copy {
      message_id: vector<u8>,
      sender: address,
      dest_domain: u32,
      recipient: vector<u8>,
      // todo: add these
      // block_height: u64,
      // transaction_hash: vector<u8>,
      message: vector<u8>,
    }

    struct ProcessEvent has store, drop, copy {
      message_id: vector<u8>,
      origin_domain: u32,
      sender: vector<u8>,
      recipient: address,
      // block_height: u64,
      // transaction_hash: vector<u8>,
    }

    struct IsmSetEvent has store, drop, copy {
      message_id: vector<u8>,
      origin_domain: u32,
      sender: address,
      recipient: address,
    }

    /// Admin Capability
    struct AdminCap has key, store {
        id: UID,
    }

    // Resources
    struct MailBoxState has key, store {
      id: UID,
      owner_address: address,
      local_domain: u32,
      tree: MerkleTree,
      // Mapping (message_id => bool)
      delivered: VecMap<vector<u8>, bool>,
    }
    
    // constructor
    fun init(ctx: &mut TxContext) {
      let sender = tx_context::sender(ctx);
      transfer::transfer(AdminCap { id: object::new(ctx) }, sender);
    }

    // Entry Functions
    /// Initialize state of Mailbox 
    public entry fun create_state(
      _admin_cap: &AdminCap,
      domain: u32,
      ctx: &mut TxContext
    ) {
      let sender = tx_context::sender(ctx);
      
      let mailbox_obj = MailBoxState {
        id: object::new(ctx),
        owner_address: sender,
        local_domain: domain, // not yet set
        tree: merkle_tree::new(),
        delivered: vec_map::empty<vector<u8>, bool>(),
      };

      transfer::share_object(mailbox_obj);
    }

    ///
    /// Dispatches a message to an enrolled router via the provided Mailbox.
    ///
    public fun dispatch<T>(
      mailbox: &mut MailBoxState,
      registry: &RouterRegistry,
      dest_domain: u32,
      message_body: vector<u8>,
      _cap: &RouterCap<T>,
      ctx: &mut TxContext
    ): vector<u8> {
      let recipient: vector<u8> = router::must_have_remote_router<T>(registry, dest_domain);
      outbox_dispatch(
        mailbox,
        router::type_address<T>(),
        dest_domain,
        h256::from_bytes(&recipient),
        message_body
      )
    }

    /// Dispatches a message to an enrolled router via the local router's Mailbox
    /// and pays for it to be relayed to the destination.
    public fun dispatch_with_gas<T>(
      mailbox: &mut MailBoxState,
      registry: &RouterRegistry,
      igp: &IgpState,
      oracle_state: &OracleState,
      gas_coin: Coin<SUI>,
      dest_domain: u32,
      message_body: vector<u8>,
      gas_amount: u256,
      cap: &RouterCap<T>,
      ctx: &mut TxContext
    ) {
      let message_id = dispatch<T>(mailbox, registry, dest_domain, message_body, cap, ctx);
      igps::pay_for_gas(
        igp,
        oracle_state,
        gas_coin,
        message_id,
        dest_domain,
        gas_amount,
        ctx
      );
    }


    /// Handles an incoming message
    public fun handle_message<T>(
      registry: &RouterRegistry,
      ism: &ISM,
      mailbox: &mut MailBoxState,
      message: vector<u8>,
      metadata: vector<u8>,
      _cap: &RouterCap<T>,
      ctx: &mut TxContext
    ) {
      let src_domain = msg_utils::origin_domain(&message);
      let sender_addr = msg_utils::sender(&message);
      router::assert_router_should_be_enrolled<T>(registry, src_domain, sender_addr);
      inbox_process(
        mailbox,
        ism,
        message,
        metadata
      );
    }

    /// Attempts to deliver `message` to its recipient. Verifies
    /// `message` via the recipient's ISM using the provided `metadata`.
    ///! `message` should be in a specific format
    fun inbox_process(
      mailbox: &mut MailBoxState,
      ism: &ISM,
      message: vector<u8>,
      metadata: vector<u8>
    ) {

      assert!(msg_utils::version(&message) == utils::get_version(), ERROR_VERSION_MISMATCH);
      assert!(msg_utils::dest_domain(&message) == mailbox.local_domain, ERROR_DOMAIN_MISMATCH);

      let id = msg_utils::id(&message);
      assert!(!vec_map::contains(&mailbox.delivered, &id), ERROR_ALREADY_DELIVERED);

      // mark it as delivered
      vec_map::insert(&mut mailbox.delivered, id, true);
      
      assert!(multisig_ism::verify(ism, &metadata, &message), ERROR_VERIFY_FAILED);

      // emit process event

      event::emit(ProcessEvent {
        message_id: id,
        origin_domain: mailbox.local_domain,
        sender: msg_utils::sender(&message),
        recipient: msg_utils::recipient(&message)
      });
    }

    /// Dispatches a message to the destination domain & recipient.
    fun outbox_dispatch(
      mailbox: &mut MailBoxState,
      sender_address: address,
      destination_domain: u32,
      _recipient: H256, // package::module
      message_body: vector<u8>,
    ): vector<u8> {
      
      let tree_count = outbox_get_count(mailbox);

      assert!(vector::length(&message_body) < MAX_MESSAGE_BODY_BYTES, ERROR_MSG_LENGTH_OVERFLOW);
      
      // convert H256 to 32-bytes vector
      let recipient = h256::to_bytes(&_recipient);

      //! Emit Event so that the relayer can fetch message content
      // TODO : optimize format_message_into_bytes. id() consumes memory

      let message_bytes = msg_utils::format_message_into_bytes(
        utils::get_version(), // version
        tree_count,   // nonce
        mailbox.local_domain,   // domain
        sender_address,          // sender address
        destination_domain,   // destination domain
        recipient,            // recipient
        message_body
      );

      // extend merkle tree
      let id = msg_utils::id(&message_bytes);
      merkle_tree::insert(&mut mailbox.tree, id);

      // emit dispatch event
      event::emit(DispatchEvent {
          message_id: id,
          sender: sender_address,
          dest_domain: destination_domain,
          recipient: recipient,
          message: message_bytes,
      });

      id
    }

    // Admin Functions

    /// Transfer ownership of MailBox
    public fun transfer_ownership(admin_cap: AdminCap, new_owner_address: address, ctx: &mut TxContext) {
      let sender = tx_context::sender(ctx);
      transfer::public_transfer(admin_cap, sender);
    }

    #[view]
    /// Returns the number of inserted leaves in the tree
    public fun outbox_get_count(mailbox: &MailBoxState): u32 {
      (merkle_tree::count(&mailbox.tree) as u32)
    }
    
    #[test_only]
    public fun init_for_test(ctx: &mut TxContext) {
      init(ctx)
    }
}