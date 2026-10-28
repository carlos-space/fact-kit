//! Reads the facts of this sample (`facts/`, built to `facts/dist` by `pnpm -C facts build`).
//! Needs only the facts build, not the installed package: run it alone with `cargo test --test own_facts`.

use std::path::PathBuf;

use fact_kit::{ReadFactsOptions, read_facts};

#[test]
fn own_facts_value_comes_from_the_built_facts() {
    let options = ReadFactsOptions {
        root: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("facts")),
        ..ReadFactsOptions::default()
    };
    // Self-reference: facts/package.json is named rust-sample-facts and exports ./sample/index.json.
    let reader = read_facts("rust-sample-facts/sample", &options).unwrap_or_else(|e| {
        panic!(
            "cannot read rust-sample-facts/sample ({}). Run `pnpm install` and `pnpm -C facts build` first.",
            e.code()
        )
    });
    assert_eq!(reader.package, "rust-sample-facts");
    let value = reader.value("rust-sample.greeting-max-length");
    assert_eq!(value.and_then(|v| v.as_i64()), Some(42));
}
