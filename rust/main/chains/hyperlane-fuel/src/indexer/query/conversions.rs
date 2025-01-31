use fuel_core_client::client::schema::ConversionError::{self, MissingField};
use fuel_core_types::{
    fuel_asm::{Instruction, Word},
    fuel_tx::{PanicInstruction, PanicReason},
};
use fuels::tx::Receipt as FuelReceipt;

use super::{types::Receipt, ReceiptType};

// These conversions are the `From` implementations for converting the `Receipt` schema from the Fuels Rust SDK
// since we cannot implement `From` for our custom Recipt schema on the `fuels::tx::Receipt` directly.

pub fn generate_receipt(schema: Receipt) -> Result<FuelReceipt, ConversionError> {
    Ok(match schema.receipt_type {
        ReceiptType::Call => FuelReceipt::Call {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            to: schema
                .to
                .ok_or_else(|| MissingField("to".to_string()))?
                .into(),
            amount: schema
                .amount
                .ok_or_else(|| MissingField("amount".to_string()))?
                .into(),
            asset_id: schema
                .asset_id
                .ok_or_else(|| MissingField("assetId".to_string()))?
                .into(),
            gas: schema
                .gas
                .ok_or_else(|| MissingField("gas".to_string()))?
                .into(),
            param1: schema
                .param1
                .ok_or_else(|| MissingField("param1".to_string()))?
                .into(),
            param2: schema
                .param2
                .ok_or_else(|| MissingField("param2".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::Return => FuelReceipt::Return {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            val: schema
                .val
                .ok_or_else(|| MissingField("val".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::ReturnData => FuelReceipt::ReturnData {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            ptr: schema
                .ptr
                .ok_or_else(|| MissingField("ptr".to_string()))?
                .into(),
            len: schema
                .len
                .ok_or_else(|| MissingField("len".to_string()))?
                .into(),
            digest: schema
                .digest
                .ok_or_else(|| MissingField("digest".to_string()))?
                .into(),
            data: Some(
                schema
                    .data
                    .ok_or_else(|| MissingField("data".to_string()))?
                    .into(),
            ),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::Panic => FuelReceipt::Panic {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            reason: {
                let reason = schema
                    .reason
                    .ok_or_else(|| MissingField("reason".to_string()))?;
                word_to_panic_instruction(reason.into())
            },
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
            contract_id: schema.contract_id.map(Into::into),
        },
        ReceiptType::Revert => FuelReceipt::Revert {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            ra: schema
                .ra
                .ok_or_else(|| MissingField("ra".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::Log => FuelReceipt::Log {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            ra: schema
                .ra
                .ok_or_else(|| MissingField("ra".to_string()))?
                .into(),
            rb: schema
                .rb
                .ok_or_else(|| MissingField("rb".to_string()))?
                .into(),
            rc: schema
                .rc
                .ok_or_else(|| MissingField("rc".to_string()))?
                .into(),
            rd: schema
                .rd
                .ok_or_else(|| MissingField("rd".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::LogData => FuelReceipt::LogData {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            ra: schema
                .ra
                .ok_or_else(|| MissingField("ra".to_string()))?
                .into(),
            rb: schema
                .rb
                .ok_or_else(|| MissingField("rb".to_string()))?
                .into(),
            ptr: schema
                .ptr
                .ok_or_else(|| MissingField("ptr".to_string()))?
                .into(),
            len: schema
                .len
                .ok_or_else(|| MissingField("len".to_string()))?
                .into(),
            digest: schema
                .digest
                .ok_or_else(|| MissingField("digest".to_string()))?
                .into(),
            data: Some(
                schema
                    .data
                    .ok_or_else(|| MissingField("data".to_string()))?
                    .into(),
            ),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::Transfer => FuelReceipt::Transfer {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            to: schema
                .to
                .ok_or_else(|| MissingField("to".to_string()))?
                .into(),
            amount: schema
                .amount
                .ok_or_else(|| MissingField("amount".to_string()))?
                .into(),
            asset_id: schema
                .asset_id
                .ok_or_else(|| MissingField("assetId".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::TransferOut => FuelReceipt::TransferOut {
            id: schema.id.map(|id| id.into()).unwrap_or_default(),
            to: schema
                .to_address
                .ok_or_else(|| MissingField("to_address".to_string()))?
                .into(),
            amount: schema
                .amount
                .ok_or_else(|| MissingField("amount".to_string()))?
                .into(),
            asset_id: schema
                .asset_id
                .ok_or_else(|| MissingField("assetId".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::ScriptResult => FuelReceipt::ScriptResult {
            result: Word::from(
                schema
                    .result
                    .ok_or_else(|| MissingField("result".to_string()))?,
            )
            .into(),
            gas_used: schema
                .gas_used
                .ok_or_else(|| MissingField("gas_used".to_string()))?
                .into(),
        },
        ReceiptType::MessageOut => FuelReceipt::MessageOut {
            sender: schema
                .sender
                .ok_or_else(|| MissingField("sender".to_string()))?
                .into(),
            recipient: schema
                .recipient
                .ok_or_else(|| MissingField("recipient".to_string()))?
                .into(),
            amount: schema
                .amount
                .ok_or_else(|| MissingField("amount".to_string()))?
                .into(),
            nonce: schema
                .nonce
                .ok_or_else(|| MissingField("nonce".to_string()))?
                .into(),
            len: schema
                .len
                .ok_or_else(|| MissingField("len".to_string()))?
                .into(),
            digest: schema
                .digest
                .ok_or_else(|| MissingField("digest".to_string()))?
                .into(),
            data: Some(
                schema
                    .data
                    .ok_or_else(|| MissingField("data".to_string()))?
                    .into(),
            ),
        },
        ReceiptType::Mint => FuelReceipt::Mint {
            sub_id: schema
                .sub_id
                .ok_or_else(|| MissingField("sub_id".to_string()))?
                .into(),
            contract_id: schema.id.map(|id| id.into()).unwrap_or_default(),
            val: schema
                .val
                .ok_or_else(|| MissingField("val".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
        ReceiptType::Burn => FuelReceipt::Burn {
            sub_id: schema
                .sub_id
                .ok_or_else(|| MissingField("sub_id".to_string()))?
                .into(),
            contract_id: schema.id.map(|id| id.into()).unwrap_or_default(),
            val: schema
                .val
                .ok_or_else(|| MissingField("val".to_string()))?
                .into(),
            pc: schema
                .pc
                .ok_or_else(|| MissingField("pc".to_string()))?
                .into(),
            is: schema
                .is
                .ok_or_else(|| MissingField("is".to_string()))?
                .into(),
        },
    })
}

const WORD_SIZE: usize = core::mem::size_of::<Word>();
const REASON_OFFSET: Word = (WORD_SIZE * 8 - 8) as Word;
const INSTR_OFFSET: Word = REASON_OFFSET - (Instruction::SIZE * 8) as Word;

#[allow(clippy::cast_possible_truncation)]
pub fn word_to_panic_instruction(val: Word) -> PanicInstruction {
    // Safe to cast as we've shifted the 8 MSB.
    let reason_u8 = (val >> REASON_OFFSET) as u8;
    // Cast to truncate in order to remove the `reason` bits.
    let instruction = (val >> INSTR_OFFSET) as u32;
    let reason = PanicReason::from(reason_u8);
    PanicInstruction::error(reason, instruction)
}
