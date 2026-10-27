use std::fmt;

/// An error a reader returns. `code()` is the stable code shared by every language. The message is for
/// people and can change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactReadError {
    /// The file is not JSON, the top level is not an object, `facts` is not an array or `package` is not a string.
    NotAnIndex(String),
    /// The `indexFormat` major is not 1, or it is not a `<number>.<number>` string.
    UnsupportedIndexFormat(String),
    /// The package or its `index.json` can not be found, or the spec is malformed.
    NotFound(String),
    /// A queried `version` or a `since` in the index is not a semver version.
    InvalidVersion(String),
}

impl FactReadError {
    /// The stable error code: `not-an-index`, `unsupported-index-format`, `not-found` or `invalid-version`.
    pub fn code(&self) -> &str {
        match self {
            FactReadError::NotAnIndex(_) => "not-an-index",
            FactReadError::UnsupportedIndexFormat(_) => "unsupported-index-format",
            FactReadError::NotFound(_) => "not-found",
            FactReadError::InvalidVersion(_) => "invalid-version",
        }
    }

    /// The message for people.
    pub fn message(&self) -> &str {
        match self {
            FactReadError::NotAnIndex(m)
            | FactReadError::UnsupportedIndexFormat(m)
            | FactReadError::NotFound(m)
            | FactReadError::InvalidVersion(m) => m,
        }
    }
}

impl fmt::Display for FactReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message(), self.code())
    }
}

impl std::error::Error for FactReadError {}
