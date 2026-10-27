//! Consumer harness for the Rust reader: runs the shared samples of `conformance/` against the `fact-kit`
//! crate that Cargo resolved, through its public API only. run.sh writes the Cargo.toml that names the crate
//! (a registry version, or a local copy through `[patch.crates-io]`) and prints where Cargo got it from.
//! `FACT_KIT_CONFORMANCE` names the conformance/ directory.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use fact_kit::{
    FactReadError, ReadFactsOptions, SelectOptions, compare_versions, read_facts, release_line,
    select_facts,
};
use serde_json::{Value, json};

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn dirs(root: &Path, kind: &str) -> Vec<(String, PathBuf)> {
    let mut out: Vec<_> = fs::read_dir(root.join(kind))
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    out.sort();
    out
}

/// Equality as JS sees it: numbers by value, objects without key order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn query_options(query: &Value) -> SelectOptions {
    let text = |k: &str| query.get(k).and_then(Value::as_str).map(str::to_string);
    SelectOptions {
        version: text("version"),
        include: query
            .get("include")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        platform: text("platform"),
        os: text("os"),
    }
}

/// The shape of `expected.json`: facts sorted by id, or the error code.
fn outcome(result: Result<Vec<fact_kit::SelectedFact>, FactReadError>) -> Value {
    match result {
        Err(e) => json!({ "error": e.code() }),
        Ok(mut facts) => {
            facts.sort_by(|a, b| a.id.encode_utf16().cmp(b.id.encode_utf16()));
            let facts: Vec<Value> = facts
                .into_iter()
                .map(|f| {
                    let mut o = serde_json::Map::new();
                    o.insert("id".into(), f.id.into());
                    o.insert("content".into(), f.content);
                    o.insert("since".into(), f.since);
                    if let Some(s) = f.stability {
                        o.insert("stability".into(), s.into());
                    }
                    Value::Object(o)
                })
                .collect();
            json!({ "facts": facts })
        }
    }
}

fn main() -> ExitCode {
    let Ok(dir) = std::env::var("FACT_KIT_CONFORMANCE") else {
        eprintln!("FACT_KIT_CONFORMANCE is not set");
        return ExitCode::FAILURE;
    };
    let root = PathBuf::from(dir);
    let mut failures: Vec<String> = Vec::new();
    let mut check = |name: String, got: &Value, expected: &Value| {
        if !same(got, expected) {
            failures.push(format!("{name}\n  got      {got}\n  expected {expected}"));
        }
    };

    let cases = dirs(&root, "cases");
    for (name, dir) in &cases {
        let index = read_json(&dir.join("index.json"));
        let query = read_json(&dir.join("query.json"));
        let got = outcome(select_facts(&index, &query_options(&query)));
        check(format!("cases/{name}"), &got, &read_json(&dir.join("expected.json")));
    }

    let resolves = dirs(&root, "resolve");
    for (name, dir) in &resolves {
        let query = read_json(&dir.join("query.json"));
        let spec = query["spec"].as_str().unwrap_or("").to_string();
        let sel = query_options(&query);
        let options = ReadFactsOptions {
            root: Some(dir.join("root")),
            version: sel.version,
            include: sel.include,
            platform: sel.platform,
            os: sel.os,
        };
        let got = outcome(read_facts(&spec, &options).map(|r| r.facts));
        check(format!("resolve/{name}"), &got, &read_json(&dir.join("expected.json")));
    }

    let (mut compares, mut lines) = (0, 0);
    let entries = read_json(&root.join("semver.json"));
    for e in entries.as_array().expect("semver.json is an array") {
        if let (Some(a), Some(b)) = (e.get("a"), e.get("b")) {
            compares += 1;
            let got = compare_versions(a.as_str().unwrap(), b.as_str().unwrap()).unwrap() as i64;
            check(format!("semver/{a} vs {b}"), &json!(got), &json!(e["expected"].as_i64().unwrap()));
        } else {
            lines += 1;
            let (version, line) = (e["version"].as_str().unwrap(), e["line"].as_str().unwrap());
            check(format!("semver/line {version}"), &json!(release_line(version).ok()), &json!(line));
        }
    }

    // a harness that read nothing proves nothing
    if cases.len() < 80 || resolves.len() < 15 || compares <= 50 || lines <= 5 {
        failures.push(format!(
            "too few samples in {}: {} cases, {} resolve, {compares} compares, {lines} lines",
            root.display(),
            cases.len(),
            resolves.len()
        ));
    }

    println!("conformance: {}", root.display());
    println!(
        "samples: {} cases, {} resolve, {compares} version comparisons, {lines} release lines",
        cases.len(),
        resolves.len()
    );
    if failures.is_empty() {
        println!("ok: every sample matches expected.json");
        ExitCode::SUCCESS
    } else {
        eprintln!("FAILED: {}", failures.len());
        for f in &failures {
            eprintln!("{f}");
        }
        ExitCode::FAILURE
    }
}
