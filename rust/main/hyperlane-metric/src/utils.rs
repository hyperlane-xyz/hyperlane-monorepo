use std::fmt::Write;

use url::Url;

/// converts url into a host:port string
pub fn url_to_host_info(url: &Url) -> Option<String> {
    // check if url has scheme, if not, then add a dummy one
    // to satisfy Url's parsing schema
    match url.domain() {
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
            write!(&mut s, ":{port}").unwrap();
        }
        Some(s)
    } else {
        None
    }
}
