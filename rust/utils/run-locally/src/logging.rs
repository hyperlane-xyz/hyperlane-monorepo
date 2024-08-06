macro_rules! log {
    ($arg:literal) => {
        log!($arg,)
    };
    ($arg:literal, $($rest:tt)*) => {
        ::std::println!(concat!("<E2E> ", $arg), $($rest)*)
    };
}

pub(crate) use log;
