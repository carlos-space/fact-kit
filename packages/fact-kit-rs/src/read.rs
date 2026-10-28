use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::FactReadError;
use crate::resolve::resolve_file;
use crate::select::{SelectOptions, SelectedFact, assert_index, select_facts};

/// Options of [`read_facts`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadFactsOptions {
    /// Directory the package is resolved from. Defaults to the current working directory.
    pub root: Option<PathBuf>,
    /// The version the reader runs, or `"head"`. See [`SelectOptions::version`].
    pub version: Option<String>,
    /// Labels of `pending` rows a reader on `head` also gets.
    pub include: Vec<String>,
    /// The reader's platform.
    pub platform: Option<String>,
    /// The reader's os.
    pub os: Option<String>,
}

/// Where the described component is published, from the `publish` of the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publish {
    /// `npm`, `pypi`, `crates`, `go` or `swift`.
    pub target: String,
    /// The name of the package on that target.
    pub name: String,
}

/// The facts one reader sees, with where they came from.
#[derive(Debug, Clone, PartialEq)]
pub struct FactReader {
    /// The `package` of the index.
    pub package: String,
    /// Version of the installed fact package, from its `package.json`. Empty when it can not be found.
    pub version: String,
    /// The `entry` of the index, else the path of the spec.
    pub entry: String,
    /// The component this entry describes and the version it covers. It is never compared with what is installed.
    pub describes: BTreeMap<String, String>,
    /// Where the component is published. `None` when the index has no `publish`. It is not used to check any version.
    pub publish: Option<Publish>,
    /// The facts this reader sees, each flattened to the row that applies.
    pub facts: Vec<SelectedFact>,
}

impl FactReader {
    /// Whether a fact with this id exists.
    pub fn has(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    /// The fact with this id.
    pub fn get(&self, id: &str) -> Option<&SelectedFact> {
        self.facts.iter().find(|f| f.id == id)
    }

    /// The `content.value` of the fact with this id. `None` when there is no such fact or it has no value content.
    pub fn value(&self, id: &str) -> Option<&Value> {
        self.get(id)?.content.get("value")
    }
}

/// Splits `@scope/name/path/to/entry` or `name/path` into the package name and the sub-path.
fn split_spec(spec: &str) -> Result<(String, String), FactReadError> {
    let parts: Vec<&str> = spec.split('/').collect();
    let name_length = if spec.starts_with('@') { 2 } else { 1 };
    if parts.len() < name_length || parts.iter().any(|p| p.is_empty()) {
        return Err(FactReadError::NotFound(format!(
            "read_facts: \"{spec}\" is not of the form \"<package>\" or \"<package>/<path>\""
        )));
    }
    Ok((
        parts[..name_length].join("/"),
        parts[name_length..].join("/"),
    ))
}

/// The `package.json` version of the package `name` that contains `file`, found by walking up from it.
fn owning_version(file: &Path, name: &str) -> String {
    for dir in file.ancestors().skip(1) {
        let Ok(text) = fs::read_to_string(dir.join("package.json")) else {
            continue;
        };
        let Ok(Value::Object(pkg)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if pkg.get("name").and_then(Value::as_str) == Some(name) {
            return pkg
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    }
    String::new()
}

/// Reads the built `index.json` of `<package>` or `<package>/<path>` as installed under `root`.
///
/// The package is resolved like Node's `require`: self-reference, `node_modules` in every parent directory,
/// symbolic links and `exports` with the conditions `node-addons`, `node`, `require`, `module-sync` and
/// `default`. The package must export `./index.json` or `./<path>/index.json`. Every failure to find the file
/// is [`FactReadError::NotFound`].
///
/// The `describes` of the index is returned but not compared with the installed product.
pub fn read_facts(spec: &str, options: &ReadFactsOptions) -> Result<FactReader, FactReadError> {
    let (package_name, entry) = split_spec(spec)?;
    let root = match &options.root {
        Some(r) => r.clone(),
        None => env::current_dir().map_err(|e| {
            FactReadError::NotFound(format!("read_facts: no current directory ({e})"))
        })?,
    };
    let root = if root.is_absolute() {
        root
    } else {
        env::current_dir().map(|c| c.join(&root)).unwrap_or(root)
    };
    let target = if entry.is_empty() {
        format!("{package_name}/index.json")
    } else {
        format!("{package_name}/{entry}/index.json")
    };
    let file = resolve_file(&root, &target)?;
    let not_an_index = |why: String| {
        FactReadError::NotAnIndex(format!(
            "read_facts: {} is not a fact index ({why})",
            file.display()
        ))
    };
    let text = fs::read_to_string(&file).map_err(|e| not_an_index(e.to_string()))?;
    let index: Value = serde_json::from_str(&text).map_err(|e| not_an_index(e.to_string()))?;
    assert_index(&index, &format!("read_facts: {}", file.display()))?;

    let facts = select_facts(
        &index,
        &SelectOptions {
            version: options.version.clone(),
            include: options.include.clone(),
            platform: options.platform.clone(),
            os: options.os.clone(),
        },
    )?;
    let describes = index
        .get("describes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let publish = index
        .get("publish")
        .and_then(Value::as_object)
        .and_then(|p| {
            Some(Publish {
                target: p.get("target")?.as_str()?.to_string(),
                name: p.get("name")?.as_str()?.to_string(),
            })
        });
    Ok(FactReader {
        package: index
            .get("package")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        version: owning_version(&file, &package_name),
        entry: index
            .get("entry")
            .and_then(Value::as_str)
            .map_or(entry, str::to_string),
        describes,
        publish,
        facts,
    })
}
