/// Creates a more ergonomic way to parse configuration using a "pipeline".
///
/// Converts this:
/// ```ignore
/// parse! {
///     p(err)
///     |> get_key("chains")?
///     |> get_obj_iter()?
///     |> filter(|(k, _)| filter.contains(*k))
///     |> collect()
/// }
/// ```
///
/// Into this something equivalent to this:
/// ```ignore
/// p.get_key("chains")
///     .take_config_err(&mut err)
///     .and_then(|v| {
///         v.get_obj_iter()
///             .take_config_err(&mut err)
///     })
///     .map(|v| {
///         v.filter((|(k, _)| filter.contains(*k)))
///     })
///     .map(|v| v.collect())
/// ```
#[macro_export]
macro_rules! parse {
    // Entrypoint, start chain with `Some(parser)` for symmetry
    {$parser:ident($err:ident) $($rest:tt)*} => {
        parse!(@a
            { Some($parser.clone()) },
            $parser($err)
            $($rest)*
        )
    };
    // Handles a case where there is a double `??` which is useful when parsing optional values;
    // this gets called after the earlier take_config_err so we end up with a double Option.
    (@a $prev:block, $parser:ident($err:ident) ? $($rest:tt)*) => {
        parse!(@a
            { $prev.flatten() },
            $parser($err)
            $($rest)*
        )
    };
    // Primary case where a function call is made and returns a config error that we should consume
    (@a $prev:block, $parser:ident($err:ident) |> $fn1:ident$(::<$($fn1_temp:path),+>)?($($fn1_arg:expr),*)? $($rest:tt)*) => {
        parse!(@a
            {
                $prev.and_then(|v| {
                    v.$fn1$(::<$($fn1_temp),*>)?($($fn1_arg),*)
                        .take_config_err(&mut $err)
                })
            },
            $parser($err)
            $($rest)*
        )
    };
    // Function call that we don't want to consume the config error for or does not return a Result
    (@a $prev:block, $parser:ident($err:ident) |> $fn1:ident$(::<$($fn1_temp:path),+>)?($($fn1_arg:expr),*) $($rest:tt)*) => {
        parse!(@a
            {
                $prev.map(|v| v.$fn1$(::<$($fn1_temp),*>)?($($fn1_arg),*))
            },
            $parser($err)
            $($rest)*
        )
    };
    // Function call that we want to pass the chained value as an argument to and then consume the
    // config result.
    (@a $prev:block, $parser:ident($err:ident) @> $fn1:ident$(::<$($fn1_temp:path),+>)?($($fn1_arg:expr),*)? $($rest:tt)*) => {
        parse!(@a
            {
                $prev.and_then(|v| $fn1$(::<$($fn1_temp),*>)?(v, $($fn1_arg),*).take_config_err(&mut $err))
            },
            $parser($err)
            $($rest)*
        )
    };
    // Function call that we want to pass the chained value as an argument to
    (@a $prev:block, $parser:ident($err:ident) @> $fn1:ident$(::<$($fn1_temp:path),+>)?($($fn1_arg:expr),*) $($rest:tt)*) => {
        parse!(@a
            {
                $prev.map(|v| $fn1$(::<$($fn1_temp),*>)?(v, $($fn1_arg),*))
            },
            $parser($err)
            $($rest)*
        )
    };
    // Default to the type default
    (@a $prev:block, $parser:ident($err:ident) || Default) => {
        $prev.unwrap_or_default()
    };
    // Default to a defined value
    (@a $prev:block, $parser:ident($err:ident) || $default:ident) => {
        $prev.unwrap_or($default)
    };
    // Default to a literal
    (@a $prev:block, $parser:ident($err:ident) || $default:literal) => {
        $prev.unwrap_or($default)
    };
    // Default to the result of an expression
    (@a $prev:block, $parser:ident($err:ident) || $default:expr) => {
        $prev.unwrap_or_else(|| $default)
    };
    // Exit of macro which ends the chain
    (@a $prev:block, $parser:ident($err:ident)) => {
        $prev
    };
}

pub use parse;
