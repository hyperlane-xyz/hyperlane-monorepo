mod query;
pub use query::*;

mod pay;
pub use pay::*;

mod dispatch;
pub use dispatch::*;

#[derive(Debug, PartialEq)]
pub enum CommandParams {
    Connect,
    Dispatch(DispatchParams),
    Pay(PayParams),
    Query(QueryParams),
}
