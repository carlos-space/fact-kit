use std::path::{Path, PathBuf};

use oxc_resolver::{ResolveOptions, Resolver};

use crate::error::FactReadError;

/// Finds the file for `target` (`<package>/<path>/index.json`) the way `require.resolve` does from `root`.
pub(crate) fn resolve_file(root: &Path, target: &str) -> Result<PathBuf, FactReadError> {
    let options = ResolveOptions {
        condition_names: ["node-addons", "node", "require", "module-sync", "default"]
            .map(String::from)
            .to_vec(),
        extensions: vec![],
        main_files: vec![],
        main_fields: vec![],
        ..ResolveOptions::default()
    };
    let resolver = Resolver::new(options);
    resolver
        .resolve(root, target)
        .map(|r| r.into_path_buf())
        .map_err(|e| {
            FactReadError::NotFound(format!(
                "cannot resolve \"{target}\" from {}: {e}",
                root.display()
            ))
        })
}
