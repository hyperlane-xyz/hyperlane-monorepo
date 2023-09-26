module hp_igps::events {
  
  friend hp_igps::gas_oracle;
  friend hp_igps::igps;

  struct SetGasDataEvent has store, drop {
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  }

  struct GasPaymentEvent has store, drop {
    message_id: vector<u8>,
    gas_amount: u256,
    required_payment: u64,
    block_height: u64,
    transaction_hash: vector<u8>,
  }

  struct SetBeneficiaryEvent has store, drop {
    beneficiary: address
  }

  public fun new_set_gas_data_event(
    remote_domain: u32,
    token_exchange_rate: u128,
    gas_price: u128
  ): SetGasDataEvent { 
    SetGasDataEvent { remote_domain, token_exchange_rate, gas_price } 
  }

  public fun new_gas_payment_event(
    message_id: vector<u8>,
    gas_amount: u256,
    required_payment: u64,
    block_height: u64,
    transaction_hash: vector<u8>,
  ): GasPaymentEvent {
    GasPaymentEvent { message_id, gas_amount, required_payment, block_height, transaction_hash }
  }
  
  public fun new_set_beneficiary_event(
    beneficiary: address
  ): SetBeneficiaryEvent {
    SetBeneficiaryEvent { beneficiary }
  }
}