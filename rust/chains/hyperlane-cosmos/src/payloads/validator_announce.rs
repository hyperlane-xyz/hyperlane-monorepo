use hyperlane_core::H160;
use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

#[derive(Serialize, Deserialize, Debug)]
pub struct GetAnnouncedValidatorsRequest {
    pub get_announced_validators: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetAnnounceStorageLocationsRequest {
    pub get_announce_storage_locations: GetAnnounceStorageLocationsRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetAnnounceStorageLocationsRequestInner {
    pub validators: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnouncementRequest {
    announce: AnnouncementRequestInner,
}

impl AnnouncementRequest {
    pub fn new(validator: H160, storage_location: String, signature: Vec<u8>) -> Self {
        Self {
            announce: AnnouncementRequestInner {
                validator,
                storage_location,
                signature,
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct AnnouncementRequestInner {
    // TODO be conscious this puts a 0x prefix that may not be allowed!
    validator: H160,
    storage_location: String,
    #[serde(with = "hex::serde")]
    signature: Vec<u8>,
}

// ========= resp ============

#[derive(Serialize, Deserialize, Debug)]
pub struct GetAnnouncedValidatorsResponse {
    pub validators: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetAnnounceStorageLocationsResponse {
    pub storage_locations: Vec<(String, Vec<String>)>,
}
