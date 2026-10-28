//! Reads the private @carlos-space/fact-kit-sample-facts (samples/sample-facts), installed with pnpm from GitHub
//! Packages, through the published fact-kit crate. Needs `pnpm install` with NODE_AUTH_TOKEN set (see README.md).

use std::path::PathBuf;

use fact_kit::{ReadFactsOptions, read_facts};

#[test]
fn installed_private_facts_are_read() {
    let options = ReadFactsOptions {
        root: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
        ..ReadFactsOptions::default()
    };
    let reader = read_facts("@carlos-space/fact-kit-sample-facts/sample", &options).unwrap_or_else(|e| {
        panic!(
            "cannot read @carlos-space/fact-kit-sample-facts/sample ({}). Is the package installed? Run `pnpm install` with NODE_AUTH_TOKEN set.",
            e.code()
        )
    });
    assert_eq!(
        reader.value("fact-kit-sample.greeting").and_then(|v| v.as_str()),
        Some("hello from a private facts package")
    );
    assert_eq!(reader.value("fact-kit-sample.max-retries").and_then(|v| v.as_i64()), Some(3));
}
