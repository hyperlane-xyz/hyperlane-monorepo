"""Focused extraction regressions; no generation, compiler or network access."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import generate_metrics as metrics


class TestSourceItems(unittest.TestCase):
    def test_leading_import_and_real_test_module(self):
        text = '''#[cfg(test)]
use crate::testing::Fixture;
const NAME: &str = "production";
fn production(metrics: &CoreMetrics) {
    metrics.new_int_gauge(NAME, "Real gauge", &["chain"]);
}
#[cfg(test)]
mod tests {
    fn test_registration(metrics: &CoreMetrics) {
        metrics.new_int_gauge("test_only", "Must not register", &["test"]);
    }
}
fn after_tests(metrics: &CoreMetrics) {
    metrics.new_int_counter("after_tests", "Still production", &["chain"]);
}
'''
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "fixture.rs").write_text(text)
            with patch.object(metrics, "ROOT", root):
                actual = metrics.parse_file("fixture.rs", "relayer")
        self.assertEqual([d["name"] for d in actual], ["hyperlane_production", "hyperlane_after_tests"])
        self.assertEqual(metrics.strip_test_items(text).count("\n"), text.count("\n"))

    def test_test_fields_methods_and_comment_attributes(self):
        text = '''// #[cfg(test)] must not remove production
struct Production {
    #[cfg(test)] test_field: Map<(u32, u32), Arc<Mutex<Vec<u8>>>>,
    real_field: u64,
}
impl Production {
    #[cfg(test)] fn helper(&self, x: [u8; 3]) { let unused = "}"; }
    fn real(&self) { real(); }
}
'''
        actual = metrics.strip_test_items(text)
        self.assertNotIn("test_field", actual)
        self.assertNotIn("fn helper", actual)
        self.assertIn("real_field", actual)
        self.assertIn("fn real", actual)

    def test_actual_nine_websocket_descriptors(self):
        text = (metrics.ROOT / "rust/main/agents/relayer/src/scraper_websocket.rs").read_text()
        test_module = text.index("#[cfg(test)]\nmod tests")
        self.assertFalse(metrics.strip_test_items(text)[test_module:].strip())
        actual = metrics.parse_file("rust/main/agents/relayer/src/scraper_websocket.rs", "relayer")
        prefix = "hyperlane_relayer_scraper_websocket_"
        shapes = {
            "active": ("int_gauge", ["chain"]),
            "authority": ("int_gauge", ["chain"]),
            "fresh": ("int_gauge", ["chain"]),
            "events": ("int_counter", ["chain", "event_type", "result"]),
            "caught_up": ("int_gauge", ["chain", "event_type"]),
            "degraded": ("int_gauge", ["chain", "event_type"]),
            "parity": ("int_counter", ["chain", "event_type", "result"]),
            "parity_pending": ("int_gauge", ["chain", "event_type"]),
            "parity_ready": ("int_gauge", ["chain", "event_type"]),
        }
        self.assertEqual(len(actual), 9)
        self.assertEqual({d["name"] for d in actual}, {prefix + name for name in shapes})
        for descriptor in actual:
            kind, labels = shapes[descriptor["name"].removeprefix(prefix)]
            self.assertEqual(descriptor["kind"], kind)
            self.assertEqual(descriptor["labels"], labels)


if __name__ == "__main__":
    unittest.main()
