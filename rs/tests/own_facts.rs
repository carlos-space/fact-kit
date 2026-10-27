//! The facts of this reader describe its error codes. They must match the codes the crate returns.
//! Needs the built `facts/dist` of this repository (`pnpm build` in `facts/`).

use std::path::PathBuf;

use fact_kit::{FactReadError, ReadFactsOptions, read_facts};

#[test]
fn read_errors_fact_lists_the_codes_of_the_crate() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../facts");
    let options = ReadFactsOptions {
        root: Some(root),
        ..ReadFactsOptions::default()
    };
    // Resolved through self-reference: `facts/package.json` is named `fact-kit-facts` and exports `./rs/index.json`.
    let reader = read_facts("fact-kit-facts/rs", &options).expect("read fact-kit-facts/rs");
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
