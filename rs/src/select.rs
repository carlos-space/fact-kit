use std::cmp::Ordering;

use semver::Version;
use serde_json::{Map, Value};

use crate::error::FactReadError;

/// What `since` reads as when a row does not have one.
pub const NO_SINCE: &str = "0.0.0";

/// What a reader sees. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectOptions {
    /// The version of the described component the reader runs, or `"head"` for the unreleased state. Without
    /// it the reader is newer than every released version, so it gets the latest published content.
    pub version: Option<String>,
    /// Labels of `pending` rows a reader on `head` also gets.
    pub include: Vec<String>,
    /// A row with a `platforms` condition applies only when the reader names a platform it lists.
    pub platform: Option<String>,
    /// A row with an `os` condition applies only when the reader names an os it lists.
    pub os: Option<String>,
}

/// A fact as one reader sees it: the row that applies is flattened into `content`, `since` and `stability`.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectedFact {
    pub id: String,
    /// The `content` of the row that was chosen. `Null` when the row has none.
    pub content: Value,
    /// The `since` of the row that was chosen, as written: a string or an array. `"0.0.0"` when the row has none.
    pub since: Value,
    /// `Some("experimental")` when the chosen row is experimental.
    pub stability: Option<String>,
    /// The other fields of the fact (`tool`, `topics`, `title`, `when` and so on), without `variants`.
    pub fields: Map<String, Value>,
}

enum Reader {
    Head,
    Latest,
    Version(Version),
}

#[derive(Clone)]
enum Bound {
    Min,
    Version(Version),
    Max,
}

impl Bound {
    fn rank(&self) -> u8 {
        match self {
            Bound::Min => 0,
            Bound::Version(_) => 1,
            Bound::Max => 2,
        }
    }
}

fn compare_bounds(a: &Bound, b: &Bound) -> Ordering {
    match (a, b) {
        (Bound::Version(x), Bound::Version(y)) => x.cmp_precedence(y),
        _ => a.rank().cmp(&b.rank()),
    }
}

fn parse_version(text: &str) -> Option<Version> {
    Version::parse(text).ok()
}

fn must_parse(value: &Value, what: &str) -> Result<Version, FactReadError> {
    value.as_str().and_then(parse_version).ok_or_else(|| {
        FactReadError::InvalidVersion(format!("{what} {value} is not a semver 2.0.0 version"))
    })
}

fn same_line(a: &Version, b: &Version) -> bool {
    a.major == b.major && a.minor == b.minor
}

fn compare_lines(a: &Version, b: &Version) -> Ordering {
    (a.major, a.minor).cmp(&(b.major, b.minor))
}

struct Row<'a> {
    since: Option<&'a Value>,
    content: Option<&'a Value>,
    pending: Option<&'a Value>,
    stability: Option<&'a Value>,
    platforms: Option<&'a Value>,
    os: Option<&'a Value>,
}

fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// The rows of a fact. Without `variants` the whole fact is one row that starts at `when.since`.
fn rows_of(fact: &Map<String, Value>) -> Vec<Row<'_>> {
    if let Some(Value::Array(variants)) = fact.get("variants") {
        return variants
            .iter()
            .filter_map(Value::as_object)
            .map(|v| Row {
                since: v.get("since"),
                content: v.get("content"),
                pending: v.get("pending"),
                stability: v.get("stability"),
                platforms: v.get("platforms"),
                os: v.get("os"),
            })
            .collect();
    }
    let when = fact.get("when").and_then(Value::as_object);
    vec![Row {
        since: when.and_then(|w| w.get("since")),
        content: fact.get("content"),
        pending: None,
        stability: None,
        platforms: when.and_then(|w| w.get("platforms")),
        os: when.and_then(|w| w.get("os")),
    }]
}

fn bound_of(
    since: Option<&Value>,
    reader: &Reader,
    id: &str,
) -> Result<Option<Bound>, FactReadError> {
    let Some(since) = since else {
        return Ok(Some(Bound::Min));
    };
    let what = format!("fact {id}: since");
    match since {
        Value::String(s) if s == "next" => Ok(matches!(reader, Reader::Head).then_some(Bound::Max)),
        Value::String(_) => {
            let s = must_parse(since, &what)?;
            if let Reader::Version(r) = reader
                && r.cmp_precedence(&s) == Ordering::Less
            {
                return Ok(None);
            }
            Ok(Some(Bound::Version(s)))
        }
        Value::Array(items) => {
            let has_next = items.iter().any(|s| s.as_str() == Some("next"));
            let versions = items
                .iter()
                .filter(|s| s.as_str() != Some("next"))
                .map(|s| must_parse(s, &what))
                .collect::<Result<Vec<_>, _>>()?;
            let Some(newest) = versions.iter().max_by(|a, b| a.cmp_precedence(b)).cloned() else {
                return Ok(matches!(reader, Reader::Head).then_some(Bound::Max));
            };
            match reader {
                Reader::Version(r) => {
                    if let Some(same) = versions.iter().find(|s| same_line(s, r)) {
                        return Ok((r.cmp_precedence(same) != Ordering::Less)
                            .then(|| Bound::Version(same.clone())));
                    }
                    // No version on the reader's line: the row applies once the reader's line is newer than all.
                    let newer = versions
                        .iter()
                        .all(|s| compare_lines(r, s) == Ordering::Greater);
                    Ok(newer.then_some(Bound::Version(newest)))
                }
                Reader::Head if has_next => Ok(Some(Bound::Max)),
                _ => Ok(Some(Bound::Version(newest))),
            }
        }
        _ => Err(FactReadError::InvalidVersion(format!(
            "{what} must be a string or an array"
        ))),
    }
}

struct Context<'a> {
    include: &'a [String],
    platform: Option<&'a str>,
    os: Option<&'a str>,
}

fn lists(condition: &Value, wanted: Option<&str>) -> bool {
    match (condition, wanted) {
        (Value::Array(items), Some(w)) => items.iter().any(|i| i.as_str() == Some(w)),
        _ => false,
    }
}

fn specificity(row: &Row) -> usize {
    usize::from(present(row.platforms).is_some()) + usize::from(present(row.os).is_some())
}

struct Candidate<'r, 'a> {
    row: &'r Row<'a>,
    bound: Bound,
}

fn candidates<'r, 'a>(
    rows: &'r [Row<'a>],
    reader: &Reader,
    ctx: &Context,
    id: &str,
) -> Result<Vec<Candidate<'r, 'a>>, FactReadError> {
    let mut out = Vec::new();
    for row in rows {
        if let Some(pending) = present(row.pending) {
            let included = matches!(reader, Reader::Head)
                && pending
                    .as_str()
                    .is_some_and(|p| ctx.include.iter().any(|i| i == p));
            if !included {
                continue;
            }
        }
        if present(row.platforms).is_some_and(|p| !lists(p, ctx.platform)) {
            continue;
        }
        if present(row.os).is_some_and(|o| !lists(o, ctx.os)) {
            continue;
        }
        if let Some(bound) = bound_of(row.since, reader, id)? {
            out.push(Candidate { row, bound });
        }
    }
    Ok(out)
}

/// Larger bound first, then more conditions.
fn rank(a: &Candidate, b: &Candidate) -> Ordering {
    compare_bounds(&a.bound, &b.bound).then_with(|| specificity(a.row).cmp(&specificity(b.row)))
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| cmp_utf16(a.0, b.0));
            let parts: Vec<_> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), canonical(v)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// UTF-16 code unit order, which is what JS string comparison uses.
fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn canonical_row(row: &Row) -> String {
    let mut map = Map::new();
    for (key, value) in [
        ("since", row.since),
        ("content", row.content),
        ("pending", row.pending),
        ("stability", row.stability),
        ("platforms", row.platforms),
        ("os", row.os),
    ] {
        if let Some(v) = value {
            map.insert(key.to_string(), v.clone());
        }
    }
    canonical(&Value::Object(map))
}

/// The row that applies: the largest bound, then the more specific condition, then the smaller canonical text.
fn choose_row<'r, 'a>(
    rows: &'r [Row<'a>],
    reader: &Reader,
    ctx: &Context,
    id: &str,
) -> Result<Option<&'r Row<'a>>, FactReadError> {
    let mut best: Option<Candidate<'r, 'a>> = None;
    for c in candidates(rows, reader, ctx, id)? {
        let take = match &best {
            None => true,
            Some(b) => match rank(&c, b) {
                Ordering::Greater => true,
                Ordering::Equal => {
                    cmp_utf16(&canonical_row(c.row), &canonical_row(b.row)) == Ordering::Less
                }
                Ordering::Less => false,
            },
        };
        if take {
            best = Some(c);
        }
    }
    Ok(best.map(|c| c.row))
}

/// Checks the top of an index and returns its facts.
pub(crate) fn assert_index<'a>(
    index: &'a Value,
    label: &str,
) -> Result<&'a Vec<Value>, FactReadError> {
    let not_an_index = || FactReadError::NotAnIndex(format!("{label} is not a fact index"));
    let Value::Object(raw) = index else {
        return Err(not_an_index());
    };
    // A missing field is format 1.0. Readers take any 1.x and ignore fields they do not know.
    let format = raw
        .get("indexFormat")
        .cloned()
        .unwrap_or_else(|| Value::String("1.0".into()));
    if !is_format_1(&format) {
        return Err(FactReadError::UnsupportedIndexFormat(format!(
            "{label} has index format {format}, and this reader takes 1.x"
        )));
    }
    match (raw.get("facts"), raw.get("package")) {
        (Some(Value::Array(facts)), Some(Value::String(_))) => Ok(facts),
        _ => Err(not_an_index()),
    }
}

/// Matches `^(\d+)\.\d+$` with a major that reads as 1, so `"01.0"` counts like JS does.
fn is_format_1(format: &Value) -> bool {
    let Some(text) = format.as_str() else {
        return false;
    };
    let Some((major, minor)) = text.split_once('.') else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(major) && digits(minor) && major.trim_start_matches('0') == "1"
}

fn reader_of(version: Option<&str>) -> Result<Reader, FactReadError> {
    match version {
        None => Ok(Reader::Latest),
        Some("head") => Ok(Reader::Head),
        Some(v) => parse_version(v).map(Reader::Version).ok_or_else(|| {
            FactReadError::InvalidVersion(format!(
                "query version \"{v}\" is not a semver 2.0.0 version"
            ))
        }),
    }
}

/// The newest released version any row of the index names, which is how new a reader of `latest` is.
fn newest_released(facts: &[&Map<String, Value>]) -> Option<Version> {
    let mut newest: Option<Version> = None;
    for fact in facts {
        for row in rows_of(fact) {
            let Some(since) = row.since else { continue };
            if row.pending.is_some() {
                continue;
            }
            let items: &[Value] = match since {
                Value::Array(items) => items,
                other => std::slice::from_ref(other),
            };
            for item in items {
                let v = item
                    .as_str()
                    .filter(|s| *s != "next")
                    .and_then(parse_version);
                if let Some(v) = v
                    && newest
                        .as_ref()
                        .is_none_or(|n| v.cmp_precedence(n) == Ordering::Greater)
                {
                    newest = Some(v);
                }
            }
        }
    }
    newest
}

fn removed(fact: &Map<String, Value>, reader: &Reader, latest: Option<&Version>) -> bool {
    let at = fact
        .get("when")
        .and_then(|w| w.get("removeIn"))
        .and_then(Value::as_str);
    let Some(at) = at else { return false };
    if matches!(reader, Reader::Head) {
        return true;
    }
    if at == "next" {
        return false;
    }
    let Some(gone) = parse_version(at) else {
        return false;
    };
    let current = match reader {
        Reader::Version(v) => Some(v),
        _ => latest,
    };
    current.is_some_and(|c| c.cmp_precedence(&gone) != Ordering::Less)
}

/// The facts one reader sees. A pure function over a parsed `index.json` of format 1.x.
///
/// Each fact has rows (`variants`, or the whole fact as one row). A row applies to the reader when its
/// `since` has been reached, its `pending` label is included, and its `platforms` and `os` conditions list
/// the reader's platform and os. Of the rows that apply the one with the largest bound wins, and on a tie the
/// one with more conditions. A fact without an applying row, or whose `removeIn` has been reached, is left
/// out. The result keeps the order of the index.
pub fn select_facts(
    index: &Value,
    options: &SelectOptions,
) -> Result<Vec<SelectedFact>, FactReadError> {
    let all = assert_index(index, "the index")?;
    let reader = reader_of(options.version.as_deref())?;
    let ctx = Context {
        include: &options.include,
        platform: options.platform.as_deref(),
        os: options.os.as_deref(),
    };
    let facts: Vec<&Map<String, Value>> = all.iter().filter_map(Value::as_object).collect();
    let latest = if matches!(reader, Reader::Latest) {
        newest_released(&facts)
    } else {
        None
    };
    let mut out = Vec::new();
    for fact in facts {
        let Some(Value::String(id)) = fact.get("id") else {
            continue;
        };
        let rows = rows_of(fact);
        let Some(row) = choose_row(&rows, &reader, &ctx, id)? else {
            continue;
        };
        if removed(fact, &reader, latest.as_ref()) {
            continue;
        }
        let fields = fact
            .iter()
            .filter(|(k, _)| !matches!(k.as_str(), "variants" | "id" | "content"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        out.push(SelectedFact {
            id: id.clone(),
            content: row.content.cloned().unwrap_or(Value::Null),
            since: row
                .since
                .cloned()
                .unwrap_or_else(|| Value::String(NO_SINCE.into())),
            stability: row.stability.and_then(Value::as_str).map(str::to_string),
            fields,
        });
    }
    Ok(out)
}

/// Compares two semver 2.0.0 versions by precedence. Build metadata is ignored.
pub fn compare_versions(a: &str, b: &str) -> Result<Ordering, FactReadError> {
    let parse = |text: &str| {
        parse_version(text).ok_or_else(|| {
            FactReadError::InvalidVersion(format!(
                "version \"{text}\" is not a semver 2.0.0 version"
            ))
        })
    };
    Ok(parse(a)?.cmp_precedence(&parse(b)?))
}

/// The release line `X.Y` of a version. `0.49.0-alpha.1` is on line `0.49`.
pub fn release_line(version: &str) -> Result<String, FactReadError> {
    let v = parse_version(version).ok_or_else(|| {
        FactReadError::InvalidVersion(format!(
            "version \"{version}\" is not a semver 2.0.0 version"
        ))
    })?;
    Ok(format!("{}.{}", v.major, v.minor))
}
