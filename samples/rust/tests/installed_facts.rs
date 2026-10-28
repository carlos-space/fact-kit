//! Reads the fact-kit-rs entry of fact-kit-facts, installed from npm with pnpm, through the published fact-kit crate.
//! Needs `pnpm install` first (see README.md).

use std::path::PathBuf;

use fact_kit::{ReadFactsOptions, read_facts};

#[test]
fn installed_facts_have_the_fact_kit_rs_facts() {
    let options = ReadFactsOptions {
        root: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
        ..ReadFactsOptions::default()
    };
    let reader = read_facts("fact-kit-facts/fact-kit-rs", &options).unwrap_or_else(|e| {
        panic!("cannot read fact-kit-facts/fact-kit-rs ({}). Is the package installed? Run `pnpm install`.", e.code())
    });
    assert!(!reader.facts.is_empty(), "the fact-kit-rs entry has no facts");
    for id in ["fact-kit-rs.read-facts", "fact-kit-rs.read-errors"] {
        assert!(reader.has(id), "fact id {id} is missing");
    }
}
