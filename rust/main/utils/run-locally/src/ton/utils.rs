use crate::program::Program;
use crate::utils::TaskHandle;
use std::env;
use std::path::Path;

pub trait Pipe: Sized {
    fn pipe<F: FnOnce(Self) -> Self>(self, func: F) -> Self {
        func(self)
    }
}

impl<T> Pipe for T {}

pub fn build_rust_bins(bins: &[&str]) {
    Program::new("cargo")
        .cmd("build")
        .working_dir("../../")
        .pipe(|program| {
            bins.iter()
                .fold(program, |prog, bin| prog.arg("bin", bin.to_string()))
        })
        .arg("features", "test-utils")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();
}

pub fn resolve_abs_path<P: AsRef<Path>>(rel_path: P) -> String {
    let mut configs_path = env::current_dir().unwrap();
    configs_path.push(rel_path);
    configs_path
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned()
}
