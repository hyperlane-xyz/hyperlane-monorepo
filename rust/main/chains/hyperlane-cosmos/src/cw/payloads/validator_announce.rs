use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GetAnnouncedValidatorsRequest {
    pub get_announced_validators: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GetAnnounceStorageLocationsRequest {
    pub get_announce_storage_locations: GetAnnounceStorageLocationsRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GetAnnounceStorageLocationsRequestInner {
    pub validators: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnouncementRequest {
    pub announce: AnnouncementRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnouncementRequestInner {
    pub validator: String,
    pub storage_location: String,
    pub signature: String,
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
