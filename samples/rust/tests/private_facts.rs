//! Reads the url-scheme facts of the private @carlos-space/notchhub-facts. The package is UNLICENSED and this
//! repository is public, so the test checks ids and the count only and never prints a title or content.
//! Needs `pnpm install` with a NODE_AUTH_TOKEN that has read:packages (see README.md).

use std::path::PathBuf;

use fact_kit::{ReadFactsOptions, read_facts};

#[test]
fn private_facts_url_scheme_has_the_command_facts() {
    let options = ReadFactsOptions {
        root: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
        ..ReadFactsOptions::default()
    };
    let reader = read_facts("@carlos-space/notchhub-facts/url-scheme", &options).unwrap_or_else(|e| {
        panic!(
            "cannot read @carlos-space/notchhub-facts/url-scheme ({}). Is the package installed? Run `pnpm install` with NODE_AUTH_TOKEN set.",
            e.code()
        )
    });
    assert!(!reader.facts.is_empty(), "the url-scheme entry has no facts");
    for id in ["notchhub.command-open", "notchhub.command-clear"] {
        assert!(reader.has(id), "fact id {id} is missing");
    }
}
