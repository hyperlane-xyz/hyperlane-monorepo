//! Direct production configuration sources; never reads the real environment.
#[path = "../../../rust/main/hyperlane-base/src/settings/loader/arguments.rs"]
mod arguments;
#[path = "../../../rust/main/hyperlane-base/src/settings/loader/case_adapter.rs"]
mod case_adapter;
#[path = "../../../rust/main/hyperlane-base/src/settings/loader/environment.rs"]
mod environment;
use config::{Config, File, FileFormat};
use convert_case::Case;
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn run(v: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let mut b = Config::builder();
    for layer in v["layers"].as_array().into_iter().flatten() {
        b = b.add_source(case_adapter::CaseAdapter::new(
            File::from_str(&layer.to_string(), FileFormat::Json),
            Case::Flat,
        ));
    }
    let env: Vec<(String, String)> = v["environment"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    let args: Vec<std::ffi::OsString> = v["arguments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    b = b.add_source(case_adapter::CaseAdapter::new(
        environment::Environment::default()
            .prefix("HYP_")
            .separator("_")
            .source(env),
        Case::Flat,
    ));
    b = b.add_source(case_adapter::CaseAdapter::new(
        arguments::CommandLineArguments::default()
            .separator(".")
            .source(args),
        Case::Flat,
    ));
    Ok(b.build()?.try_deserialize::<Value>()?)
}
fn main() {
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        println!(
            "{}",
            match run(v) {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(_) => json!({"ok":false}),
            }
        );
    }
}
