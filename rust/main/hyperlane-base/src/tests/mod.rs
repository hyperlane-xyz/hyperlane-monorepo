/// Mock Checkpoint Syncer
pub mod mock_checkpoint_syncer;

use hyperlane_core::CheckpointWithMessageId;

const PRIVATE_KEY_1: &str = "254bf805ec98536bbcfcf7bd88f58aa17bcf2955138237d3d06288d39fabfecb";
const PUBLIC_KEY_1: &str = "c4bED0DD629b734C96779D30e1fcFa5346863C4C";

const PRIVATE_KEY_2: &str = "5c5ec0dd04b7a8b4ea7d204bb8d30159fe33bdf29c0015986b430ff5b952b5fb";
const PUBLIC_KEY_2: &str = "96DE69f859ed40FB625454db3BFc4f2Da4848dcF";

const PRIVATE_KEY_3: &str = "113c56f0b006dd07994ec518eb02a9b37ddd2187232bc8ea820b1fe7d719c6cd";
const PUBLIC_KEY_3: &str = "c7504D7F7FC865Ba69abad3b18c639372AE687Ec";

const PRIVATE_KEY_4: &str = "9ccd363180a8e11730d017cf945c93533070a5e755f178e171bee861407b225a";
const PUBLIC_KEY_4: &str = "197325f955852A61a5b2DEFb7BAffB8763D1acE8";

const PRIVATE_KEY_5: &str = "3fdfa6dd5c1e40e5c7dc84e82253cdb96c90a6d400542e21d5e69965adc44077";
const PUBLIC_KEY_5: &str = "2C8Ac45c649C1d242706FB1fc078bc0759c02f80";

const PRIVATE_KEY_6: &str = "3367a1ee365c349e51b1b55ade243b001536225dc581cc5940bebc2214c415d1";
const PUBLIC_KEY_6: &str = "34D691B987892487477eABBB3ce57De196291319";

const PRIVATE_KEY_7: &str = "6845eaefd5de4851eae6e41174e87a0569fad8c3b4f579b46a434f9471a40d72";
const PUBLIC_KEY_7: &str = "cAbF1DC890E8bf998Cd4664BAcDd64d67D8d4F1A";

/// parameters for a validator for creating a mock checkpoint syncer
#[derive(Clone, Debug)]
pub struct TestValidator {
    /// private key
    pub private_key: String,
    /// public key
    pub public_key: String,
    /// latest index response
    pub latest_index: Option<u32>,
    /// fetch checkpoint response
    pub fetch_checkpoint: Option<CheckpointWithMessageId>,
}

/// Generate some dummy validators for tests
pub fn dummy_validators() -> Vec<TestValidator> {
    vec![
        TestValidator {
            private_key: PRIVATE_KEY_1.into(),
            public_key: PUBLIC_KEY_1.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_2.into(),
            public_key: PUBLIC_KEY_2.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_3.into(),
            public_key: PUBLIC_KEY_3.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_4.into(),
            public_key: PUBLIC_KEY_4.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_5.into(),
            public_key: PUBLIC_KEY_5.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_6.into(),
            public_key: PUBLIC_KEY_6.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
        TestValidator {
            private_key: PRIVATE_KEY_7.into(),
            public_key: PUBLIC_KEY_7.into(),
            latest_index: None,
            fetch_checkpoint: None,
        },
    ]
}
