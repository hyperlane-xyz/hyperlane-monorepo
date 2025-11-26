use {
    crate::utils::agent_settings::args::Args2,
    cargo_metadata::MetadataCommand,
    std::{
        path::PathBuf,
        process::{Child, Command},
    },
};

pub trait Launcher: Sized + Args2 {
    const PATH: &'static str;

    fn launch(self) -> Child {
        let args = self
            .args()
            .into_iter()
            .map(|(key, value)| {
                let v = vec![format!("--{key}"), value];
                println!("{:?}", v);
                v
            })
            .flatten()
            .collect::<Vec<_>>();

        Command::new(format!("./target/debug/{}", Self::PATH))
            .args(args)
            .current_dir(workspace())
            .spawn()
            .unwrap()
    }
}

fn workspace() -> PathBuf {
    MetadataCommand::new()
        .exec()
        .unwrap()
        .workspace_root
        .into_std_path_buf()
}
