module hp_validator::events {
  use std::string::String;
  
  friend hp_validator::validator_announce;

  // event resources
  struct AnnouncementEvent has store, drop {
    validator: address,
    storage_location: String,
  }

  // create events
  public fun new_validator_announce_event(
    validator: address,
    storage_location: String,
  ): AnnouncementEvent {
    AnnouncementEvent { validator, storage_location }
  }

}