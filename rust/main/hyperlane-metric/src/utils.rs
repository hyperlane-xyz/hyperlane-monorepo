use std::fmt::Write;

use url::Url;

/// converts url into a host:port string
pub fn url_to_host_info(url: &Url) -> Option<String> {
    // if the URL lacks a host/authority (e.g. parsed as an opaque URL like
    // "grpc.example.com:234"), prepend a dummy scheme and reparse to extract host:port
    match url.host_str() {
        None => {
            let with_dummy_scheme = format!("https://{url}");
            let url = Url::parse(&with_dummy_scheme).ok()?;
            schemed_url_to_host_info(&url)
        }
        Some(_) => schemed_url_to_host_info(url),
    }
}

fn schemed_url_to_host_info(url: &Url) -> Option<String> {
    if let Some(host) = url.host_str() {
        let mut s = String::new();
        s.push_str(host);
        if let Some(port) = url.port_or_known_default() {
            let _ = write!(&mut s, ":{port}");
        }
        Some(s)
    } else {
        None
    }
}
