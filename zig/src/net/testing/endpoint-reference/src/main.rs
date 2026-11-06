//! Actual production Url2.5.4 serialization corpus for vote identities.
fn main() {
    for input in [
        "HTTPS://EXAMPLE.COM:443",
        "http://EXAMPLE.COM:80/a/./b/../c",
        "https://example.com/a/%2e/b/%2E%2e/c",
        "https://example.com/a//b/../",
        "https://user:@EXAMPLE.com/path?q=1%202",
        "https://@example.com/",
        "http://127.0.0.1:080/",
        "http://127.1/",
        "http://2130706433/",
        "http://0177.0.0.1/",
        "http://0x7f000001/",
        "https://[2001:0DB8:0:0:0:0:0:1]:443/a",
        "http://[::ffff:127.0.0.1]/",
        "https://bücher.example/",
        "https://%65xample.com/",
        "https://xn--bcher-kva.example/",
        "https://EXAMPLE.com./",
        "https://fixture.invalid/a%2fb?z=%2f&x=1+2",
        "https://fixture.invalid?x=",
        "https://fixture.invalid/path?",
        "https://user%41:pass%2f@example.com/",
        "https://fixture.invalid/a/../..",
        "https://fixture.invalid/a/.%2e/b",
        "https://fixture.invalid/a/%2e./b",
        "https://fixture.invalid/a/%2e%2E/b",
        "https://fixture.invalid//a///./b/../../c",
    ] {
        let canonical = url::Url::parse(input)
            .expect("valid public fixture URL")
            .to_string();
        println!(
            "{}",
            serde_json::json!({"input":input,"canonical":canonical})
        );
    }
}
