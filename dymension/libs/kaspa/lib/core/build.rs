// use paperclip::v2::{
//     self,
//     codegen::{DefaultEmitter, Emitter, EmitterState},
//     models::{DefaultSchema, ResolvableApi},
// };

use paperclip::v3::{
    self,
    codegen::{DefaultEmitter, Emitter, EmitterState},
    models::{DefaultSchema, ResolvableApi},
};

use std::env;
use std::fs::File;

fn main() {
    let fd = File::open("./src/query/openapi.json").expect("schema?");
    let raw: ResolvableApi<DefaultSchema> = v3::from_reader(fd).expect("deserializing spec");
    let schema = raw.resolve().expect("resolution");

    let o="/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/libs/kaspa/lib/core/src/query/generated";
    let out_dir = env::var(o).unwrap();
    let mut state = EmitterState::default();
    // set prefix for using generated code inside `codegen` module (see main.rs).
    state.mod_prefix = "crate::codegen::";
    state.working_dir = out_dir.into();

    let emitter = DefaultEmitter::from(state);
    emitter.generate(&schema).expect("codegen");
}
