"""Pure Docker capability controls; no daemon connection or native tools."""
import copy
import pathlib
import tempfile
import unittest
from unittest import mock
import multivm_evidence as evidence


class DockerCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ziggy-docker-capability-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.manifest = {"scenario": "evm", "task_root": str(self.root)}
        self.docker = {"host": "unix:///var/run/docker.sock", "config_dir": str(self.root / "docker-config")}
        self.case = {"local_docker": self.docker}

    def environment(self):
        return mock.patch.dict(evidence.os.environ, {"DOCKER_HOST": self.docker["host"], "DOCKER_CONFIG": self.docker["config_dir"]}, clear=True)

    def test_all_seven_docker_families_bind_independent_capability(self):
        for family in evidence.DOCKER_FIXTURE_FAMILIES:
            with self.subTest(family=family), self.environment():
                manifest = dict(self.manifest, scenario=family)
                self.assertEqual(evidence.validate_docker_approval(manifest, self.case, self.case), self.docker)
                if family != "starknet":
                    self.assertEqual(evidence.validate_evidence_nodes(manifest, self.case), {})

    def test_capability_is_required_by_actual_approval_not_plain_planning(self):
        self.assertEqual(evidence.validate_evidence_nodes(self.manifest, {}), {})
        with self.assertRaisesRegex(ValueError, "capability missing"):
            evidence.validate_docker_approval(self.manifest, {}, {})

    def test_capability_never_authorizes_cross_family_evidence_peer(self):
        for family in evidence.DOCKER_FIXTURE_FAMILIES - {"starknet"}:
            with self.subTest(family=family), self.assertRaisesRegex(ValueError, "Starknet-only"):
                evidence.validate_evidence_nodes(dict(self.manifest, scenario=family), dict(self.case, evidence_nodes={"foreign": {}}))
        with self.assertRaisesRegex(ValueError, "must be explicit"):
            evidence.validate_evidence_nodes(dict(self.manifest, scenario="starknet"), self.case)

    def test_unadmitted_and_composite_capability_is_rejected(self):
        for family in ("sealevel-composite", "aleo", "unknown"):
            with self.subTest(family=family), self.assertRaises(ValueError):
                evidence.validate_local_docker(dict(self.manifest, scenario=family), self.case)

    def test_exact_approval_and_explicit_environment_required(self):
        for approval in ({}, {"local_docker": dict(self.docker, host="unix:///other.sock")}):
            with self.environment(), self.assertRaisesRegex(ValueError, "ownership approval"):
                evidence.validate_docker_approval(self.manifest, self.case, approval)
        for key in ("DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_AUTH_CONFIG"):
            with self.subTest(key=key), self.environment(), mock.patch.dict(evidence.os.environ, {key: "foreign"}), self.assertRaisesRegex(ValueError, "ambient overrides"):
                evidence.validate_docker_approval(self.manifest, self.case, self.case)

    def test_only_literal_local_unix_socket_is_permitted(self):
        for host in ("tcp://127.0.0.1:2375", "unix://remote/socket", "unix:///", "unix:///tmp/../docker.sock", "unix:///tmp/%2e%2e/docker.sock", "unix:///socket?x", "unix:///socket#x", "unix:///socket\n", "unix:///tmp\\socket"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                evidence.validate_local_docker(self.manifest, {"local_docker": dict(self.docker, host=host)})

    def test_config_is_exact_owned_directory_and_not_symlink(self):
        for config in (str(self.root), str(self.root / "other"), str(self.root / "docker-config" / "nested"), "/tmp/foreign-docker-config"):
            with self.subTest(config=config), self.assertRaises(ValueError):
                evidence.validate_local_docker(self.manifest, {"local_docker": dict(self.docker, config_dir=config)})
        config = self.root / "docker-config"
        config.write_text("not a directory")
        with self.assertRaises(ValueError):
            evidence.validate_local_docker(self.manifest, self.case)
        config.unlink()
        config.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            evidence.validate_local_docker(self.manifest, self.case)
        config.unlink()
        config.mkdir()
        self.assertEqual(evidence.validate_local_docker(self.manifest, self.case), self.docker)

    def test_extra_capability_fields_rejected(self):
        with self.assertRaises(ValueError):
            evidence.validate_local_docker(self.manifest, {"local_docker": dict(self.docker, arbitrary_override=True)})


if __name__ == "__main__":
    unittest.main()
