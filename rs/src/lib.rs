//! Reads the facts of a fact-kit `index.json`.
//!
//! [`read_facts`] finds the built index of a `-facts` package the way Node's `require` does and returns a
//! [`FactReader`]. [`select_facts`] is the pure function under it, over a parsed index.

mod error;
mod read;
mod resolve;
mod select;

pub use error::FactReadError;
pub use read::{FactReader, ReadFactsOptions, read_facts};
pub use select::{
    NO_SINCE, SelectOptions, SelectedFact, compare_versions, release_line, select_facts,
};
