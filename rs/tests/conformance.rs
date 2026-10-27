//! Runs the shared samples of `conformance/` against the public API.
//! Locate them with `FACT_KIT_CONFORMANCE`, else by walking up from `CARGO_MANIFEST_DIR`.

use std::fs;
use std::path::{Path, PathBuf};

use fact_kit::{
    FactReadError, ReadFactsOptions, SelectOptions, compare_versions, read_facts, release_line,
    select_facts,
};
use serde_json::{Value, json};

fn conformance_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FACT_KIT_CONFORMANCE") {
        return PathBuf::from(dir);
    }
    let start = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    start
        .ancestors()
        .map(|a| a.join("conformance"))
        .find(|c| c.join("semver.json").is_file())
        .expect("conformance/ not found: set FACT_KIT_CONFORMANCE")
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn dirs(kind: &str) -> Vec<(String, PathBuf)> {
    let mut out: Vec<_> = fs::read_dir(conformance_dir().join(kind))
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
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
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
            facts.sort_by(|a, b| a.id.cmp(&b.id));
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

fn check(name: &str, got: &Value, expected: &Value, failures: &mut Vec<String>) {
    if same(got, expected) {
        println!("case {name} ok");
    } else {
        println!("case {name} FAILED");
        failures.push(format!("{name}\n  got      {got}\n  expected {expected}"));
    }
}

fn finish(failures: Vec<String>) {
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn cases() {
    let cases = dirs("cases");
    assert!(cases.len() >= 80, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, dir) in cases {
        let index = read_json(&dir.join("index.json"));
        let query = read_json(&dir.join("query.json"));
        let got = outcome(select_facts(&index, &query_options(&query)));
        check(
            &format!("cases/{name}"),
            &got,
            &read_json(&dir.join("expected.json")),
            &mut failures,
        );
    }
    finish(failures);
}

#[test]
fn resolve() {
    let cases = dirs("resolve");
    assert!(cases.len() >= 15, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (name, dir) in cases {
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
        check(
            &format!("resolve/{name}"),
            &got,
            &read_json(&dir.join("expected.json")),
            &mut failures,
        );
    }
    finish(failures);
}

#[test]
fn semver() {
    let entries = read_json(&conformance_dir().join("semver.json"));
    let entries = entries.as_array().expect("semver.json is an array");
    assert!(entries.len() > 55);
    let mut failures = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if let (Some(a), Some(b)) = (e.get("a"), e.get("b")) {
            let expected = e["expected"].as_i64().unwrap();
            let got = compare_versions(a.as_str().unwrap(), b.as_str().unwrap()).unwrap() as i64;
            let name = format!(
                "semver/{i} {} vs {}",
                a.as_str().unwrap(),
                b.as_str().unwrap()
            );
            check(&name, &json!(got), &json!(expected), &mut failures);
        } else {
            let (version, line) = (e["version"].as_str().unwrap(), e["line"].as_str().unwrap());
            let got = release_line(version).ok();
            check(
                &format!("semver/{i} line {version}"),
                &json!(got),
                &json!(line),
                &mut failures,
            );
        }
    }
    finish(failures);
}
