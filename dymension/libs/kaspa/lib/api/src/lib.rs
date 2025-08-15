#![allow(unused_imports)]
#![allow(non_snake_case)]
#![allow(clippy::all)] // disable clippy for codegen
#![allow(clippy::too_many_arguments)]

extern crate reqwest;
extern crate serde;
extern crate serde_json;
extern crate serde_repr;
extern crate url;

pub mod apis;
pub mod models;
