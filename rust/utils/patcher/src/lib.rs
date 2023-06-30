use std::{
    collections::{BTreeMap, HashSet},
    fs,
    iter::IntoIterator,
    path::{Path, PathBuf},
    process,
};

use cargo_toml::{Dependency, DependencyDetail, Manifest};
use which::which;

#[derive(Clone)]
pub struct PatchDirective {
    /// Name of the monorepo
    pub name: String,
    pub url: String,
    pub refspec: Refspec,
    pub patches: Vec<String>,
    pub crates: Vec<PatchCrateDirective>,
}

#[derive(Clone)]
pub struct PatchCrateDirective {
    /// Name of the crate
    pub name: String,
    /// Version of the crate `x.y.z`
    pub version: String,
    /// Relative path to the monorepo root
    pub path: String,
}

#[derive(Clone)]
pub enum Refspec {
    Branch(String),
    Tag(String),
    Rev(String),
}

///
/// - `workspace_dir` - path to the workspace root
/// - `patch_dir` - path to the directory where the patches should be vendored
/// - `cmds` - list of patch directives to apply
pub fn patch_workspace(
    workspace_dir: impl AsRef<Path>,
    patch_dir: impl AsRef<Path>,
    cmds: impl IntoIterator<Item = PatchDirective>,
) {
    let workspace_dir = workspace_dir.as_ref().canonicalize().unwrap();
    let patch_dir = patch_dir.as_ref().canonicalize().unwrap();
    let cargo = which("cargo").expect("cargo must be installed");

    // Use `from_str` to prevent Manifest form completing itself since we want to write it back
    // more or less as it was and not with extra information
    let mut manifest = {
        let raw_manifest = fs::read_to_string(workspace_dir.join("Cargo.toml"))
            .expect("Failed to read Cargo.toml");
        Manifest::from_str(&raw_manifest).expect("Failed to load Cargo.toml")
    };

    let mut crates_used: HashSet<PathBuf> = Default::default();
    for cmd in cmds {
        cmd.run(&mut manifest, &mut crates_used, &workspace_dir, &patch_dir);
    }

    let mut manifest: String = toml::to_string_pretty(&manifest).unwrap();
    manifest.insert_str(0, "# This file is updated by `vendor.rs`;\n# changes will be incorporated but will be reformatted and comments will be lost.\n\n");
    fs::write("Cargo.toml", manifest).expect("Failed to write Cargo.toml");

    assert!(
        process::Command::new(cargo)
            .args(["fmt"])
            .current_dir(&workspace_dir)
            .status()
            .unwrap()
            .success(),
        "Failed to format workspace"
    );
}

impl PatchDirective {
    // run this patch and update the cargo manifest.
    pub fn run(
        &self,
        manifest: &mut Manifest,
        crates_used: &mut HashSet<PathBuf>,
        workspace_dir: impl AsRef<Path>,
        working_dir: impl AsRef<Path>,
    ) {
        let crates: BTreeMap<_, _> = self.crates.iter().map(|c| (&c.name, c)).collect();
        if crates.len() != self.crates.len() {
            panic!("Duplicate crate name in {}", self.name);
        }

        let workspace_dir = workspace_dir.as_ref().canonicalize().unwrap();
        println!("workspace_dir: {}", workspace_dir.display());
        let working_dir = working_dir.as_ref().canonicalize().unwrap();
        println!("working_dir: {}", working_dir.display());
        let dest_dir_rel = &self.name;
        let dest_dir = working_dir.join(dest_dir_rel);
        println!("dest_dir: {}", dest_dir.display());
        let clone_dir_rel = format!("{}_remote", self.name);
        let clone_dir = working_dir.join(&clone_dir_rel);
        println!("clone_dir: {}", clone_dir.display());

        let git = which("git").expect("git must be installed");
        println!("git: {}", git.display());
        if clone_dir.exists() {
            fs::remove_dir_all(&clone_dir).expect("Failed to remove old clone dir");
        }
        fs::create_dir_all(&clone_dir).expect("Failed to create clone dir");
        assert!(
            process::Command::new(&git)
                .args(["init", clone_dir.to_str().unwrap()])
                .current_dir(&working_dir)
                .status()
                .unwrap()
                .success(),
            "Failed to init git repo"
        );

        println!("repo_url: {}", self.url);
        process::Command::new(&git)
            .args(["remote", "add", "external", &self.url])
            .current_dir(&clone_dir)
            .status()
            .unwrap();

        let mut _branch_ref = None;
        let (fetch_args, checkout_args) = match &self.refspec {
            Refspec::Branch(branch) => {
                _branch_ref = Some(format!("external/{branch}"));
                (
                    vec!["fetch", "external", branch, "--no-tags", "--depth", "1"],
                    vec!["checkout", _branch_ref.as_deref().unwrap(), "--detach"],
                )
            }
            Refspec::Tag(tag) => (
                vec!["fetch", "external", "tag", tag, "--no-tags", "--depth", "1"],
                vec!["checkout", tag, "--detach"],
            ),
            Refspec::Rev(rev) => (
                vec!["fetch", "external", rev, "--no-tags", "--depth", "1"],
                vec!["checkout", rev, "--detach"],
            ),
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

        for patch_path in &self.patches {
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
            fs::remove_dir_all(&dest_dir).expect("Failed to remove dest dir");
        }

        fs::remove_dir_all(clone_dir.join(".git")).expect("Failed to remove .git dir");
        fs::rename(&clone_dir, &dest_dir).expect("Failed to rename repo dir");
        println!("Moved {} to {}", clone_dir.display(), dest_dir.display());

        let dir = working_dir.join(&self.name);
        for (_, c) in crates {
            let dep_path = pathdiff::diff_paths(&dir.join(&c.path), &workspace_dir)
                .expect("dep_path must be in workspace_dir");
            patch_dep(manifest, &c.name, &c.version, &dep_path);
            suppress_warnings(&dep_path, crates_used);
        }

        let is_monorepo = !(self.crates.len() == 1 && self.crates[0].path == ".");
        for entry in dir.read_dir().unwrap().map(Result::unwrap) {
            if entry.file_type().unwrap().is_dir() {
                let file_name = entry.file_name();
                let fns = file_name.to_str().unwrap();
                if fns.starts_with('.') {
                    fs::remove_dir_all(entry.path()).unwrap();
                }
            } else if is_monorepo {
                fs::remove_file(entry.path()).unwrap();
            } else {
                let file_name = entry.file_name();
                let fns = file_name.to_str().unwrap();
                if fns != "Cargo.toml" && fns != "Cargo.lock" {
                    fs::remove_file(entry.path()).unwrap();
                }
            }
        }
    }
}

pub fn patch_dep(manifest: &mut Manifest, name: &str, version: &str, path: &Path) {
    println!("Patching {} to {}", name, version);
    let path: PathBuf = path
        .components()
        .filter(|c| c.as_os_str().to_str() != Some("."))
        .collect();
    manifest
        .workspace
        .as_mut()
        .expect("No workspace dependencies!?")
        .dependencies
        .insert(name.to_owned(), Dependency::Simple(format!("={version}")));
    manifest
        .patch
        .entry("crates-io".to_owned())
        .or_default()
        .insert(
            name.to_owned(),
            Dependency::Detailed(DependencyDetail {
                version: Some(format!("={version}")),
                path: Some(path.to_str().unwrap().to_owned()),
                ..DependencyDetail::default()
            }),
        );
}

pub fn suppress_warnings(crate_path: &Path, crates_used: &mut HashSet<PathBuf>) {
    println!("Suppressing warnings in {}", crate_path.display());
    crates_used.insert(crate_path.to_owned());
    let lib_root_path = crate_path.join("src").join("lib.rs");
    if lib_root_path.is_file() {
        let raw = fs::read_to_string(&lib_root_path).expect("Failed to read lib.rs");
        let lib_root = raw
            .lines()
            .filter(|l| !(l.starts_with("#![") && l.contains("warnings")));
        let raw = ["#![allow(warnings)]"]
            .into_iter()
            .chain(lib_root)
            .collect::<Vec<&str>>()
            .join("\n");
        fs::write(lib_root_path, raw).expect("Failed to write lib.rs");
    }
    let manifest_path = crate_path.join("Cargo.toml");
    if manifest_path.is_file() {
        let dep_paths: Vec<PathBuf> = {
            // do this in a subscope so we can free up the memory of the manifest
            let raw = fs::read_to_string(&manifest_path).expect("Failed to read Cargo.toml");
            let manifest = Manifest::from_str(&raw).expect("Failed to parse Cargo.toml");
            manifest
                .dependencies
                .values()
                .filter_map(|d| d.detail())
                .filter_map(|d| d.path.as_ref())
                .filter_map(|p| crate_path.join(p).canonicalize().ok())
                .filter(|p| crates_used.insert(p.clone()))
                .collect()
        };
        for dep_path in dep_paths {
            if !crates_used.insert(dep_path.clone()) {
                // have not seen it before so recurse
                suppress_warnings(&dep_path, crates_used)
            };
        }
    }
}

// fn remove_unused_dirs(dir: &Path, crates_used: &HashSet<PathBuf>) -> bool {
//     let dir = dir.canonicalize().unwrap();
//     println!("Checking {}", dir.display());
//     if crates_used.contains(&dir) {
//         println!("Used {}", dir.display());
//         return true;
//     }
//     let mut is_used = false;
//     for entry in dir.read_dir().unwrap().map(Result::unwrap) {
//         let cur = entry.path().canonicalize().unwrap();
//         if !entry.file_type().unwrap().is_dir() {
//             continue;
//         }
//         let cur_used = remove_unused_dirs(&cur, &crates_used);
//         is_used |= cur_used;
//         if !cur_used {
//             println!("Removing unused dir {}", cur.display());
//             fs::remove_dir_all(cur).unwrap();
//         } else {
//             println!("{} is used", cur.display());
//         }
//     }
//     is_used
// }

pub mod borrowed {
    //! The borrowed types are easier to use when defining things in the code.

    #[derive(Copy, Clone)]
    pub struct PatchDirective<'a> {
        /// Name of the monorepo
        pub name: &'a str,
        pub url: &'a str,
        pub refspec: Refspec<'a>,
        pub patches: &'a [&'a str],
        pub crates: &'a [PatchCrateDirective<'a>],
    }

    #[derive(Copy, Clone)]
    pub struct PatchCrateDirective<'a> {
        /// Name of the crate
        pub name: &'a str,
        /// Version of the crate `x.y.z`
        pub version: &'a str,
        /// Relative path to the monorepo root
        pub path: &'a str,
    }

    #[derive(Copy, Clone)]
    pub enum Refspec<'a> {
        Tag(&'a str),
        Rev(&'a str),
        Branch(&'a str),
    }

    impl<'a> From<PatchDirective<'a>> for super::PatchDirective {
        fn from(p: PatchDirective) -> Self {
            super::PatchDirective {
                name: p.name.to_owned(),
                url: p.url.to_owned(),
                refspec: p.refspec.into(),
                patches: p.patches.iter().copied().map(|p| p.to_owned()).collect(),
                crates: p.crates.iter().map(|&c| c.into()).collect(),
            }
        }
    }

    impl<'a> From<PatchCrateDirective<'a>> for super::PatchCrateDirective {
        fn from(p: PatchCrateDirective) -> Self {
            super::PatchCrateDirective {
                name: p.name.to_owned(),
                version: p.version.to_owned(),
                path: p.path.to_owned(),
            }
        }
    }

    impl<'a> From<Refspec<'a>> for super::Refspec {
        fn from(r: Refspec) -> Self {
            match r {
                Refspec::Tag(tag) => super::Refspec::Tag(tag.to_owned()),
                Refspec::Rev(rev) => super::Refspec::Rev(rev.to_owned()),
                Refspec::Branch(branch) => super::Refspec::Branch(branch.to_owned()),
            }
        }
    }
}
