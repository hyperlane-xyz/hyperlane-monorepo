pub use aes_gcm_siv::Aes128GcmSiv;

pub mod aead {
    pub use aes_gcm_siv::aead::{Aead, KeyInit as NewAead};
}
