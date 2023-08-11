#[derive(Clone, Debug)]
pub struct Signer {
    pub prefix: String,
    pub(crate) private_key: Vec<u8>,
}

impl Signer {
    pub fn address(&self) -> String {
        verify::pub_to_addr(
            SigningKey::from_slice(self.private_key)
                .unwrap()
                .public_key()
                .to_bytes(),
            self.prefix.clone(),
        )
    }
}
