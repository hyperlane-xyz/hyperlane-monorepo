use std::error::Error as StdError;
use std::fmt::{self, Display, Formatter};

#[derive(Debug)]
pub struct CustomHyperlaneError(pub String);

impl Display for CustomHyperlaneError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl StdError for CustomHyperlaneError {}
