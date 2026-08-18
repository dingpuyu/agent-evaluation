from __future__ import annotations

import importlib.util
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deploy_init", ROOT / "scripts/deploy_init.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DeployInitTest(unittest.TestCase):
    def test_configuration_inherits_rag_identity_but_not_model_key(self) -> None:
        values = MODULE.deployment_values({
            "RAGLAB_API_PORT": "18080",
            "RAGLAB_AGENT_PORT": "18090",
            "RAGLAB_TENANT_A_PASSWORD": "generated-tenant-password",
        }, 18200, "localhost")
        self.assertEqual(values["RAGLAB_API_URL"], "http://host.docker.internal:18080")
        self.assertEqual(values["AGENT_EVALUATION_PASSWORD"], "generated-tenant-password")
        rendered = MODULE.render_env(values)
        self.assertNotIn("DEEPSEEK_API_KEY=", rendered)
        self.assertNotIn("EVALUATION_MODEL_API_KEY=", rendered)

    def test_private_write_is_mode_600(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ".env"
            MODULE.write_private(target, "VALUE=one\n", False)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                MODULE.write_private(target, "VALUE=two\n", False)


if __name__ == "__main__":
    unittest.main()
