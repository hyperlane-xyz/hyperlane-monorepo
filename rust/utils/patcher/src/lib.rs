use std::iter::IntoIterator;
use std::path::{Path, PathBuf};
use std::process;

use which::which;

#[derive(Default)]
pub struct Patcher {
    repo_url: Option<String>,
    repo_subdir: Option<String>,
    repo_ref: Option<Refspec>,
    patch_with: Vec<PathBuf>,
    working_dir: Option<PathBuf>,
    clone_dir: Option<PathBuf>,
    dest_dir: Option<PathBuf>,
}

pub enum Refspec {
    Branch(String),
    Tag(String),
    Rev(String),
}

impl Patcher {
    pub fn repo_url(&mut self, repo: &str) -> &mut Self {
        self.repo_url = Some(repo.to_string());
        self
    }

    pub fn repo_subdir(&mut self, repo_subdir: &str) -> &mut Self {
        self.repo_subdir = Some(repo_subdir.to_string());
        self
    }

    pub fn repo_ref(&mut self, repo_ref: Refspec) -> &mut Self {
        self.repo_ref = Some(repo_ref);
        self
    }

    /// Relative to the working_dir
    pub fn patch_with(&mut self, patch_with: impl AsRef<Path>) -> &mut Self {
        self.patch_with.push(patch_with.as_ref().into());
        self
    }

    pub fn patch_with_multiple<'a>(
        &mut self,
        patch_with: impl IntoIterator<Item = &'a str>,
    ) -> &mut Self {
        self.patch_with
            .extend(patch_with.into_iter().map(Into::into));
        self
    }

    pub fn working_dir(&mut self, working_dir: impl AsRef<Path>) -> &mut Self {
        self.working_dir = Some(working_dir.as_ref().into());
        self
    }

    /// Relative to the working_dir
    pub fn clone_dir(&mut self, clone_dir: impl AsRef<Path>) -> &mut Self {
        self.clone_dir = Some(clone_dir.as_ref().into());
        self
    }

    /// Relative to the working_dir
    pub fn dest_dir(&mut self, dest_dir: impl AsRef<Path>) -> &mut Self {
        self.dest_dir = Some(dest_dir.as_ref().into());
        self
    }

    pub fn run(&self) {
        let repo_url = self
            .repo_url
            .as_deref()
            .expect("A repo url must be specified");
        let working_dir = self
            .working_dir
            .as_deref()
            .expect("A working dir must be specified")
            .canonicalize()
            .unwrap();
        println!("working_dir: {}", working_dir.display());
        let dest_dir_rel = self.dest_dir.clone().unwrap_or_else(|| "patched".into());
        let dest_dir = working_dir.join(&dest_dir_rel);
        println!("dest_dir: {}", dest_dir.display());
        let clone_dir_rel = self
            .clone_dir
            .clone()
            .unwrap_or_else(|| working_dir.join("cloned"));
        let clone_dir = working_dir.join(&clone_dir_rel);
        println!("clone_dir: {}", clone_dir.display());

        let git = which("git").expect("git must be installed");
        println!("git: {}", git.display());
        if clone_dir.exists() {
            std::fs::remove_dir_all(&clone_dir).expect("Failed to remove old clone dir");
        }
        std::fs::create_dir_all(&clone_dir).expect("Failed to create clone dir");
        assert!(
            process::Command::new(&git)
                .args(["init", clone_dir.to_str().unwrap()])
                .current_dir(&working_dir)
                .status()
                .unwrap()
                .success(),
            "Failed to init git repo"
        );

        println!("repo_url: {}", repo_url);
        process::Command::new(&git)
            .args(["remote", "add", "external", repo_url])
            .current_dir(&clone_dir)
            .status()
            .unwrap();

        let mut _branch_ref = None;
        let (fetch_args, checkout_args) = match self.repo_ref.as_ref() {
            Some(Refspec::Branch(branch)) => {
                _branch_ref = Some(format!("external/{branch}")); (
                vec!["fetch", "external", branch, "--no-tags", "--depth", "1"],
                vec!["checkout", _branch_ref.as_deref().unwrap(), "--detach"]
            )},
            Some(Refspec::Tag(tag)) => (
                vec!["fetch", "external", "tag", tag, "--no-tags", "--depth", "1"],
                vec!["checkout", tag, "--detach"],
            ),
            Some(Refspec::Rev(rev)) => (
                vec!["fetch", "external", rev, "--no-tags", "--depth", "1"],
                vec!["checkout", rev, "--detach"],
            ),
            None => panic!("A repo ref must be specified"),
        };

        assert!(
            process::Command::new(&git)
                .args(fetch_args)
                .current_dir(&clone_dir)
                .status()
                .unwrap()
                .success(),
            "Failed to fetch revision"
        );
        assert!(
            process::Command::new(&git)
                .args(checkout_args)
                .current_dir(&clone_dir)
                .status()
                .unwrap()
                .success(),
            "Failed to checkout revision"
        );

        for patch_path in self.patch_with.iter() {
            let patch_path = working_dir.join(patch_path).canonicalize().unwrap();
            println!("patch: {}", patch_path.display());
            assert!(patch_path.is_file());
            process::Command::new(&git)
                .args(["apply", patch_path.to_str().unwrap()])
                .current_dir(&clone_dir)
                .status()
                .expect("Failed to apply patch");
        }

        if dest_dir.exists() {
            std::fs::remove_dir_all(&dest_dir).expect("Failed to remove dest dir");
        }
        if let Some(subdir) = self.repo_subdir.as_deref() {
            let subdir = clone_dir.join(subdir);
            std::fs::rename(&subdir, &dest_dir).expect("Failed to rename repo dir");
            std::fs::remove_dir_all(&clone_dir).expect("Failed to remove clone dir");
            println!(
                "Moved subdir {} to {}",
                subdir.display(),
                dest_dir.display()
            );
        } else {
            std::fs::remove_dir_all(clone_dir.join(".git")).expect("Failed to remove .git dir");
            std::fs::rename(&clone_dir, &dest_dir).expect("Failed to rename repo dir");
            println!("Moved {} to {}", clone_dir.display(), dest_dir.display());
        }
    }
}
