use std::fmt::Write;

use url::Url;

/// converts url into a host:port string
pub fn url_to_host_info(url: &Url) -> Option<String> {
    let mut s = String::new();

    if let Some(host) = url.host_str() {
        s.push_str(host);
        if let Some(port) = url.port_or_known_default() {
            write!(&mut s, ":{port}").unwrap();
        }
        Some(s)
    } else {
        let url_str = url.to_string();
        match url_str.split_once('/') {
            Some((left, _)) => Some(left.into()),
            None => Some(url_str),
        }
    }
}
