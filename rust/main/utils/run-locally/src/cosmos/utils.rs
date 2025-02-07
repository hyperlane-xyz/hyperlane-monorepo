use std::{fs, path::PathBuf};

use toml_edit::Document;

use crate::program::Program;
use crate::utils::TaskHandle;

pub(crate) fn sed(from: &str, to: &str, file: &str) {
    let mut program = Program::new("sed").raw_arg("-i");

    if cfg!(target_os = "macos") {
        program = program.cmd("");
    }

    program
        .cmd(format!("s/{from}/{to}/g"))
        .cmd(file)
        .run()
        .join()
}

pub(crate) fn untar(output: &str, dir: &str) {
    Program::new("tar")
        .flag("extract")
        .arg("file", output)
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn unzip(output: &str, dir: &str) {
    Program::new("unzip")
        .cmd(output)
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn download(output: &str, uri: &str, dir: &str) {
    Program::new("curl")
        .arg("output", output)
        .flag("location")
        .cmd(uri)
        .flag("silent")
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn modify_toml(file: impl Into<PathBuf>, modifier: Box<dyn Fn(&mut Document)>) {
    let path = file.into();
    let mut config = fs::read_to_string(&path)
        .unwrap()
        .parse::<Document>()
        .unwrap();

    modifier(&mut config);

    fs::write(path, config.to_string()).unwrap();
}
