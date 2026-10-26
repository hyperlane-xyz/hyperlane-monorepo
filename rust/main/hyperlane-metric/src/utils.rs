use url::Url;

/// Converts a parsed URL into a host:port label, excluding credentials and paths.
pub fn url_to_host_info(url: &Url) -> Option<String> {
    // Legacy gRPC inputs such as `grpc.example.com:443` parse as opaque URLs.
    // Keep that support while using parsed hosts directly for IPv4/IPv6 URLs.
    let schemed_url = if url.host_str().is_none() && url.cannot_be_a_base() {
        Some(Url::parse(&format!("https://{url}")).ok()?)
    } else {
        None
    };
    let url = schemed_url.as_ref().unwrap_or(url);
    url.host_str()
        .map(|host| match url.port_or_known_default() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_host_labels_exclude_credentials_and_support_ip_addresses() {
        for (url, expected) in [
            ("https://private-user:private-password@rpc.example/private-path?key=private-query#private-fragment", "rpc.example:443"),
            ("http://127.0.0.1:8545/private-path?key=private-query", "127.0.0.1:8545"),
            ("http://[::1]:8545/private-path", "[::1]:8545"),
            ("wss://rpc.example/private-path", "rpc.example:443"),
        ] {
            let url = Url::parse(url).expect("test URL");
            assert_eq!(url_to_host_info(&url).as_deref(), Some(expected));
        }
        assert_eq!(
            url_to_host_info(&Url::parse("file:///private-path").expect("test URL")),
            None
        );
    }
}
