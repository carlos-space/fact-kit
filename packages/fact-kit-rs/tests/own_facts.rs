//! The facts of this reader describe its error codes. They must match the codes the crate returns.
//! Needs the built `facts/dist` of this repository (`pnpm build` in `facts/`).

use std::path::PathBuf;

use fact_kit::{FactReadError, ReadFactsOptions, read_facts};

#[test]
fn read_errors_fact_lists_the_codes_of_the_crate() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../facts");
    let options = ReadFactsOptions {
        root: Some(root),
        ..ReadFactsOptions::default()
    };
    // Resolved through self-reference: `facts/package.json` is named `fact-kit-facts` and exports `./fact-kit-rs/index.json`.
    let reader = read_facts("fact-kit-facts/fact-kit-rs", &options)
        .expect("read fact-kit-facts/fact-kit-rs");
    assert_eq!(reader.package, "fact-kit-facts");

    let value = reader
        .value("fact-kit-rs.read-errors")
        .expect("fact-kit-rs.read-errors has a value");
    let documented: Vec<&str> = value["codes"]
        .as_array()
        .expect("codes is an array")
        .iter()
        .map(|c| c["code"].as_str().expect("code is a string"))
        .collect();

    let own = [
        FactReadError::NotAnIndex(String::new()),
        FactReadError::UnsupportedIndexFormat(String::new()),
        FactReadError::NotFound(String::new()),
        FactReadError::InvalidVersion(String::new()),
    ];
    let own: Vec<&str> = own.iter().map(FactReadError::code).collect();
    assert_eq!(documented, own);
}

#[test]
fn publish_is_returned_and_checks_no_version() {
    let root = std::env::temp_dir().join(format!("fact-kit-rs-publish-{}", std::process::id()));
    let package = root.join("node_modules/demo-facts");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"demo-facts","version":"1.0.0","exports":{"./index.json":"./index.json"}}"#,
    )
    .unwrap();
    let options = ReadFactsOptions {
        root: Some(root.clone()),
        ..ReadFactsOptions::default()
    };
    let write = |publish: &str| {
        std::fs::write(
            package.join("index.json"),
            format!(
                r#"{{"indexFormat":"1.2","package":"demo-facts","entry":"","describes":{{"demo-component":"0.50.0"}}{publish},"facts":[]}}"#
            ),
        )
        .unwrap();
    };
    write(r#","publish":{"target":"npm","name":"demo"}"#);
    let reader = read_facts("demo-facts", &options).unwrap();
    assert_eq!(
        reader.publish,
        Some(fact_kit::Publish {
            target: "npm".to_string(),
            name: "demo".to_string()
        })
    );
    write("");
    assert_eq!(read_facts("demo-facts", &options).unwrap().publish, None);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn walking_up_from_a_temporary_root_ends_with_not_found() {
    let options = ReadFactsOptions {
        root: Some(std::env::temp_dir()),
        ..ReadFactsOptions::default()
    };
    let error = read_facts("no-such-package-facts-xyz", &options).unwrap_err();
    assert_eq!(error.code(), "not-found");
}
