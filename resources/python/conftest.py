"""`pytest resources/python` runs both test styles here.

Older sidecar tests are scripts (module-level asserts, `print("ok")`) that patch
multi_agent_sidecar globals, so each runs in its own interpreter as one item.
Files with `def test_` functions are collected by pytest as usual."""
import subprocess
import sys
from pathlib import Path

import pytest


class ScriptFile(pytest.File):
    def collect(self):
        yield ScriptItem.from_parent(self, name=self.path.name)


class ScriptItem(pytest.Item):
    def runtest(self):
        done = subprocess.run([sys.executable, self.path.name], cwd=self.path.parent, capture_output=True, text=True, timeout=600)
        if done.returncode:
            raise AssertionError(f"{self.path.name} exited {done.returncode}\n{done.stdout[-4000:]}\n{done.stderr[-4000:]}")

    def reportinfo(self):
        return self.path, 0, self.path.name


def pytest_pycollect_makemodule(module_path: Path, parent):
    if "\ndef test_" not in module_path.read_text(encoding="utf-8"):
        return ScriptFile.from_parent(parent, path=module_path)
    return None
