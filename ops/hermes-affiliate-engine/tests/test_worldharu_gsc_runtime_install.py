import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WorldHaruGscRuntimeInstallTests(unittest.TestCase):
    def test_installer_uses_canonical_worldharu_units(self):
        source = (ROOT / "install-worldharu-gsc-runtime.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('install -m 0755 "$SOURCE_DIR/gsc_sync.py"', source)
        self.assertIn("hermes-worldharu-gsc-sync.service", source)
        self.assertIn("hermes-worldharu-gsc-sync.timer", source)
        self.assertIn(
            "systemctl enable --now hermes-worldharu-gsc-sync.timer", source
        )
        self.assertNotIn("GSC_CLIENT_SECRET=", source)
        self.assertNotIn("GSC_REFRESH_TOKEN=", source)

    def test_service_pins_worldharu_after_environment_files(self):
        service = (
            ROOT / "systemd/hermes-worldharu-gsc-sync.service"
        ).read_text(encoding="utf-8")
        environment_file = service.index("EnvironmentFile=")
        exec_start = service.index("ExecStart=")
        self.assertLess(environment_file, exec_start)
        self.assertIn("PUBLIC_BASE_URL=https://worldharu.com", service)
        self.assertIn("GSC_SITE_URL=https://worldharu.com/", service)
        self.assertIn("worldharu-gsc-status.json", service)
        self.assertIn("/culture,/en/culture", service)

    def test_installer_targets_can_be_overridden_for_safe_staging(self):
        source = (ROOT / "install-worldharu-gsc-runtime.sh").read_text(
            encoding="utf-8"
        )
        with tempfile.TemporaryDirectory() as temporary:
            self.assertTrue(Path(temporary).is_dir())
        self.assertIn("HERMES_AFFILIATE_INSTALL_DIR", source)
        self.assertIn("HERMES_AFFILIATE_STATE_DIR", source)
        self.assertIn("SYSTEMD_UNIT_DIR", source)


if __name__ == "__main__":
    unittest.main()
