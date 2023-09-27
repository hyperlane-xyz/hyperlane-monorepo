module hp_mailbox::events {
  friend hp_mailbox::mailbox;

  // event resources
  struct DispatchEvent has store, drop {
    message_id: vector<u8>,
    sender: address,
    dest_domain: u32,
    recipient: vector<u8>,
    block_height: u64,
    transaction_hash: vector<u8>,
    message: vector<u8>,
  }

  struct ProcessEvent has store, drop {
    message_id: vector<u8>,
    origin_domain: u32,
    sender: vector<u8>,
    recipient: address,
    block_height: u64,
    transaction_hash: vector<u8>,
  }

  struct IsmSetEvent has store, drop {
    message_id: vector<u8>,
    origin_domain: u32,
    sender: address,
    recipient: address,
  }

  // create events
  public fun new_dispatch_event(
    message_id: vector<u8>,
    sender: address,
    dest_domain: u32,
    recipient: vector<u8>,
    block_height: u64,
    transaction_hash: vector<u8>,
    message: vector<u8>
  ): DispatchEvent {
    DispatchEvent { message_id, sender, dest_domain, recipient, message, block_height, transaction_hash }
  }
  
  public fun new_process_event(
    message_id: vector<u8>,
    origin_domain: u32,
    sender: vector<u8>,
    recipient: address,
    block_height: u64,
    transaction_hash: vector<u8>,
  ): ProcessEvent {
    ProcessEvent { message_id, origin_domain, sender, recipient, block_height, transaction_hash }
  }
}