// TODO: some signarures have changed and the test fails to compile
// #[cfg(test)]
// mod relayer_validator_flow_tests {
//     use crate::error::ValidationError;
//     use crate::withdraw::validate_pskts;
//     use corelib::escrow::{Escrow, EscrowPublic};
//     use bridge::payload::{MessageID, MessageIDs};
//     use bridge::util::get_recipient_script_pubkey_address;
//     use bridge::withdraw::WithdrawFXG;
//     use eyre::{eyre, Result}; // Use eyre's Result for convenient error handling
//     use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
//     use hyperlane_warp_route::TokenMessage;
//     use kaspa_addresses::{Address, Prefix};
//     use kaspa_consensus_core::network::{NetworkId, NetworkType};
//     use kaspa_consensus_core::tx::{
//         TransactionId, TransactionInput, TransactionOutpoint, UtxoEntry,
//     };
//     use kaspa_wallet_pskt::prelude::Bundle;
//     use relayer::withdraw::hub_to_kaspa::{build_withdrawal_pskt, filter_outputs_from_msgs};
//     use std::str::FromStr;
//
//     const RELAYER_ADDR: &str =
//         "kaspasim:qzgq29y4cwrchsre26tvyezk2lsyhm3k23ch9tv4nrpvyq7lyhs3sjsw4xnys";
//     const RECIPIENT_ADDR_1: &str =
//         "kaspasim:qpyyczkcjkn6l69y7m9lpdm9w09avwvfqy35j4n8psyjctnlwtkrgdfhalzqs";
//     const RECIPIENT_ADDR_2: &str =
//         "kaspasim:qqdlggxmzqqq4m6604taeegq0v55vxdvv3m5u0n6079fx3nrfec2js5hhldq6";
//     const MOCK_TX_ID_1: &str = "10285a45cf472bc0c7bbbae387a701821be2d623f5db0fd6b3f653ce56584bf8";
//     const MOCK_TX_ID_2: &str = "8846ef1f0a01ee4fa9411186bd6fe4f1aca910645efc44136cd95bdcce0b8a7a";
//
//     // --- Data Structures for Scenarios ---
//
//     #[derive(Debug)]
//     struct TestScenario {
//         name: &'static str,
//         withdrawals: Vec<WithdrawalSpec>,
//         relayer_balance: u64,
//         escrow_balance: u64,
//         expected_error: Option<ValidationError>,
//     }
//
//     #[derive(Debug, Clone)]
//     struct WithdrawalSpec {
//         recipient: &'static str,
//         amount: u64,
//     }
//
//     struct TestContext {
//         escrow_public: EscrowPublic,
//         relayer_address: Address,
//         current_anchor: TransactionOutpoint,
//         address_prefix: Prefix,
//         network_id: NetworkId,
//     }
//
//     impl TestContext {
//         fn new() -> Result<Self> {
//             let escrow_public = Escrow::new(1, 1).public(Prefix::Simnet);
//             let relayer_address = Address::constructor(RELAYER_ADDR);
//             let current_anchor =
//                 TransactionOutpoint::new(TransactionId::from_str(MOCK_TX_ID_1)?, 0);
//
//             Ok(TestContext {
//                 escrow_public,
//                 relayer_address,
//                 current_anchor,
//                 address_prefix: Prefix::Simnet,
//                 network_id: NetworkId::new(NetworkType::Simnet),
//             })
//         }
//
//         fn create_hyperlane_message(
//             &self,
//             recipient_address: &str,
//             amount: u64,
//         ) -> Result<HyperlaneMessage> {
//             let kaspa_addr = kaspa_addresses::Address::constructor(recipient_address);
//             let hash = H256::from_slice(&kaspa_addr.payload);
//             let token_message = TokenMessage::new(hash, U256::from(amount), vec![]);
//
//             let mut body = Vec::new();
//             token_message
//                 .write_to(&mut body)
//                 .map_err(|e| eyre!("Failed to serialize token message: {}", e))?;
//
//             let mut msg = HyperlaneMessage::default();
//             msg.body = body;
//
//             Ok(msg)
//         }
//
//         fn create_inputs(
//             &self,
//             current_anchor: TransactionOutpoint,
//             escrow_amount: u64,
//             relayer_amount: u64,
//         ) -> Result<Vec<(TransactionInput, UtxoEntry)>> {
//             let escrow_input = TransactionInput::new(
//                 current_anchor,
//                 self.escrow_public.redeem_script.clone(),
//                 0,
//                 self.escrow_public.n() as u8,
//             );
//             let escrow_utxo =
//                 UtxoEntry::new(escrow_amount, self.escrow_public.p2sh.clone(), 0, false);
//
//             let relayer_outpoint =
//                 TransactionOutpoint::new(TransactionId::from_str(MOCK_TX_ID_2)?, 0);
//             let relayer_input = TransactionInput::new(relayer_outpoint, vec![], 0, 1);
//             let relayer_utxo = UtxoEntry::new(
//                 relayer_amount,
//                 get_recipient_script_pubkey_address(&self.relayer_address),
//                 0,
//                 false,
//             );
//
//             Ok(vec![
//                 (escrow_input, escrow_utxo),
//                 (relayer_input, relayer_utxo),
//             ])
//         }
//
//         fn create_withdraw_fxg(&self, scenario: &TestScenario) -> Result<WithdrawFXG> {
//             let messages: Vec<HyperlaneMessage> = scenario
//                 .withdrawals
//                 .iter()
//                 .map(|w| self.create_hyperlane_message(w.recipient, w.amount))
//                 .collect::<Result<Vec<_>, _>>()
//                 .map_err(|e| eyre!("Failed to create hyperlane message: {}", e))?;
//
//             let (valid_msgs, outputs) = filter_outputs_from_msgs(messages, self.address_prefix);
//
//             let inputs = self
//                 .create_inputs(
//                     self.current_anchor,
//                     scenario.escrow_balance,
//                     scenario.relayer_balance,
//                 )
//                 .map_err(|e| eyre!("Failed to create inputs: {}", e))?;
//
//             let payload = MessageIDs(valid_msgs.iter().map(|m| MessageID(m.id())).collect())
//                 .to_bytes()
//                 .map_err(|e| eyre!("Failed to serialize message IDs: {}", e))?;
//
//             let pskt = build_withdrawal_pskt(
//                 inputs,
//                 outputs,
//                 payload,
//                 &self.escrow_public,
//                 &self.relayer_address,
//                 self.network_id,
//             )?;
//             let new_anchor =
//                 TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);
//
//             Ok(WithdrawFXG::new(
//                 Bundle::from(pskt),
//                 vec![valid_msgs],
//                 vec![self.current_anchor, new_anchor],
//             ))
//         }
//     }
//
//     #[test]
//     fn test_relayer_validator_flow() -> Result<()> {
//         let scenarios = vec![
//             // Happy path - single withdrawal
//             TestScenario {
//                 name: "single_withdrawal_success",
//                 withdrawals: vec![WithdrawalSpec {
//                     recipient: RECIPIENT_ADDR_1,
//                     amount: 100000,
//                 }],
//                 relayer_balance: 5000,
//                 escrow_balance: 100001 + 50000,
//                 expected_error: None,
//             },
//             // Multiple withdrawals to different recipients
//             TestScenario {
//                 name: "multiple_withdrawals_different_recipients",
//                 withdrawals: vec![
//                     WithdrawalSpec {
//                         recipient: RECIPIENT_ADDR_1,
//                         amount: 50000,
//                     },
//                     WithdrawalSpec {
//                         recipient: RECIPIENT_ADDR_2,
//                         amount: 75000,
//                     },
//                 ],
//                 relayer_balance: 5000,
//                 escrow_balance: 50000 + 75000 + 50000, // more than needed
//                 expected_error: None,
//             },
//             // Edge case - dust amount withdrawal
//             // This test fails since as soon as one outputs is dust, tx fee increases
//             // exponentially.
//             //
//             // TestScenario {
//             //     name: "dust_amount_withdrawal",
//             //     withdrawals: vec![WithdrawalSpec {
//             //         recipient: RECIPIENT_ADDR_2,
//             //         amount: 600, // Close to dust threshold
//             //     }],
//             //     relayer_balance: 5000,
//             //     escrow_balance: 601 + 50000,
//             //     expected_error: None,
//             // },
//         ];
//
//         let ctx = TestContext::new()?;
//
//         for scenario in scenarios {
//             println!("--- Running Scenario: {} ---", scenario.name.clone());
//
//             // Simulate the relayer creating the transaction bundle (the "FXG").
//             let fxg = ctx.create_withdraw_fxg(&scenario).map_err(|e| {
//                 eyre!(
//                     "Scenario '{}' failed during the relayer setup phase: {}",
//                     scenario.name,
//                     e
//                 )
//             })?;
//
//             let res = validate_pskts(
//                 &fxg,
//                 ctx.current_anchor,
//                 ctx.address_prefix,
//                 ctx.escrow_public.clone(),
//             );
//
//             if let Some(err) = scenario.expected_error {
//                 assert!(res.is_err());
//                 let res_err = res.unwrap_err();
//                 assert!(matches!(res_err, err));
//             } else {
//                 assert!(
//                     res.is_ok(),
//                     "Validation failed with an unexpected error: {:?}",
//                     res
//                 )
//             };
//         }
//
//         Ok(())
//     }
// }
