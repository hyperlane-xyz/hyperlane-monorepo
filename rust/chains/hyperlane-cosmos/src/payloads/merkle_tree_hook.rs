use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

const TREE_DEPTH: usize = 32;

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleTreeGenericRequest<T> {
    pub merkle_hook: T,
}

pub mod requests {
    use super::*;

    #[derive(Serialize, Deserialize, Debug)]
    pub struct MerkleTree {
        pub tree: EmptyStruct,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct MerkleTreeCount {
        pub count: EmptyStruct,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct CheckPoint {
        pub check_point: EmptyStruct,
    }
}

pub mod responses {
    use super::*;

    #[derive(Serialize, Deserialize, Debug)]
    pub struct MerkleTree {
        pub branch: [String; TREE_DEPTH],
        pub count: u32,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct MerkleTreeCount {
        pub count: u32,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct CheckPoint {
        pub root: String,
        pub count: u32,
    }
}
