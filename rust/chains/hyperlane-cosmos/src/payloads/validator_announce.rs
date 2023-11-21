use serde::{Deserialize, Serialize};

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
