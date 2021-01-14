pub mod accumulator;
pub mod home;
pub mod replica;

use ethers_core::types::{Address, Signature, H256};
use ethers_signers::Signer;
use sha3::{Digest, Keccak256};

pub trait Encode {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write;
}

impl Encode for Signature {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.to_vec())?;
        Ok(64)
    }
}

fn domain_hash(origin_slip44_id: u32) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(origin_slip44_id.to_be_bytes())
            .chain("OPTICS".as_bytes())
            .finalize()
            .as_slice(),
    )
}

#[derive(Debug, Clone)]
pub struct Message {
    origin: u32,      // 4   SLIP-44 ID
    sender: H256,     // 32  Address in origin convention
    destination: u32, // 4   SLIP-44 ID
    recipient: H256,  // 32  Address in destination convention
    sequence: u32,    // 4   Count of all previous messages to destination
    body: Vec<u8>,    // 0+  Message contents
}

impl Encode for Message {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.origin.to_be_bytes())?;
        writer.write_all(self.sender.as_ref())?;
        writer.write_all(&self.destination.to_be_bytes())?;
        writer.write_all(self.recipient.as_ref())?;
        writer.write_all(&self.sequence.to_be_bytes())?;
        Ok(36 + 36 + 4 + self.body.len())
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct Update {
    origin_chain: u32,
    previous_root: H256,
    new_root: H256,
}

impl Encode for Update {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.origin_chain.to_be_bytes())?;
        writer.write_all(self.previous_root.as_ref())?;
        writer.write_all(self.new_root.as_ref())?;
        Ok(4 + 32 + 32)
    }
}

impl Update {
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain(origin) || previous_root || new_root
        H256::from_slice(
            Keccak256::new()
                .chain(domain_hash(self.origin_chain))
                .chain(self.previous_root)
                .chain(self.new_root)
                .finalize()
                .as_slice(),
        )
    }

    pub async fn sign_update<S>(self, signer: S) -> Result<SignedUpdate, S::Error>
    where
        S: Signer,
    {
        let signature = signer.sign_message(self.signing_hash()).await?;
        Ok(SignedUpdate {
            update: self,
            signature,
        })
    }
}

// 129 bytes.
// serialized as tightly-packed, sig in RSV format
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedUpdate {
    update: Update,
    signature: Signature,
}

impl Encode for SignedUpdate {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.update.write_to(writer)?;
        written += self.signature.write_to(writer)?;
        Ok(written)
    }
}

impl SignedUpdate {
    pub fn recover(&self) -> Result<Address, ()> {
        self.signature
            .recover(self.update.signing_hash())
            .map_err(|_| ())
    }
}
