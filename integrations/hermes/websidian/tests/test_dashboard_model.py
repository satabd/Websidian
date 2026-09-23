"""Dashboard tab model (dashboard/wsd_model.py): memory entries, skills, recent notes, site kinds."""

import importlib.util
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests import PLUGIN_DIR

_spec = importlib.util.spec_from_file_location("wsd_model_under_test", os.path.join(PLUGIN_DIR, "dashboard", "wsd_model.py"))
model = importlib.util.module_from_spec(_spec)
sys.modules["wsd_model_under_test"] = model
_spec.loader.exec_module(model)

BASE = "/api/plugins/websidian/w"


def write(path: Path, text: str, age: float = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if age:
        t = time.time() - age
        os.utime(path, (t, t))


class Model(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "home"
        mem = self.home / "memories"
        write(mem / "MEMORY.md", "Deploy with `make deploy`.\n§\nTwo\nlines here\n§\n<img src=x onerror=alert(1)>", age=300)
        write(mem / "USER.md", "Prefers short answers.", age=200)
        sk = self.home / "skills"
        write(sk / "devops" / "DESCRIPTION.md", "---\ndescription: Deploying and running things.\n---\n", age=400)
        write(sk / "devops" / "docker" / "SKILL.md", '---\nname: docker\ndescription: "Run containers."\n---\n# Docker\n', age=100)
        write(sk / "devops" / "docker" / "references" / "flags.md", "# Flags\n", age=400)
        write(sk / "solo" / "SKILL.md", "---\nname: solo\ndescription: >\n  Folded\n  text.\n---\n", age=400)
        write(sk / "node_modules" / "x" / "SKILL.md", "---\nname: vendored\n---\n", age=400)
        vault = self.tmp / "vault"
        write(vault / "Plan #2.md", "---\ntags: [x]\n---\n# The plan\n\nSee [[Other|the other note]] and **this**.\n", age=10)
        write(vault / ".obsidian" / "hidden.md", "not a note")
        self.sites = [
            {"path": str(vault), "slug": "brain", "title": "Second Brain", "edit": True, "untrusted": True},
            {"path": str(mem), "slug": "memories", "title": "Memories", "edit": False, "untrusted": True},
            {"path": str(sk), "slug": "skills", "title": "Skills", "edit": False, "untrusted": True},
        ]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_sites_and_kinds(self):
        m = model.overview(self.sites, BASE, self.home)
        by = {s["slug"]: s for s in m["sites"]}
        self.assertEqual([by[k]["kind"] for k in ("brain", "memories", "skills")], ["vault", "memory", "skills"])
        self.assertEqual(by["brain"]["notes"], 1)  # the dot-folder is skipped
        self.assertEqual(by["brain"]["base"], BASE + "/brain/")
        self.assertTrue(by["brain"]["edit"])
        self.assertFalse(by["brain"]["partial"])

    def test_memory_entries_and_limits(self):
        m = model.overview(self.sites, BASE, self.home, {"memory_char_limit": 3000})
        files = {f["id"]: f for f in m["memory"]["files"]}
        self.assertEqual(files["memory"]["entries"], ["Deploy with `make deploy`.", "Two\nlines here", "<img src=x onerror=alert(1)>"])
        self.assertEqual(files["memory"]["limit"], 3000)
        self.assertEqual(files["user"]["limit"], 1375)
        self.assertEqual(files["memory"]["chars"], len("\n§\n".join(files["memory"]["entries"])))
        self.assertEqual(files["memory"]["url"], BASE + "/memories/MEMORY")

    def test_missing_memory_file(self):
        (self.home / "memories" / "USER.md").unlink()
        files = {f["id"]: f for f in model.overview(self.sites, BASE, self.home)["memory"]["files"]}
        self.assertFalse(files["user"]["present"])
        self.assertNotIn("entries", files["user"])

    def test_skills(self):
        sk = model.overview(self.sites, BASE, self.home)["skills"]
        names = [s["name"] for s in sk["skills"]]
        self.assertEqual(names, ["solo", "docker"])  # uncategorised first by sort key "", vendored folder skipped
        docker = sk["skills"][1]
        self.assertEqual((docker["category"], docker["description"]), ("devops", "Run containers."))
        self.assertEqual(docker["url"], BASE + "/skills/devops/docker/SKILL")
        self.assertEqual(sk["skills"][0]["description"], "Folded text.")
        cats = {c["id"]: c for c in sk["categories"]}
        self.assertEqual(cats["devops"]["description"], "Deploying and running things.")
        self.assertEqual(sk["categories"][-1]["id"], "")  # uncategorised last

    def test_recent_previews_and_urls(self):
        recent = model.overview(self.sites, BASE, self.home)["recent"]
        first = recent[0]
        self.assertEqual((first["site"], first["title"], first["heading"]), ("brain", "Plan #2", "The plan"))
        self.assertEqual(first["excerpt"], "See the other note and this.")
        self.assertEqual(first["url"], BASE + "/brain/Plan%20%232")
        titles = {(n["site"], n["title"]) for n in recent}
        self.assertIn(("memories", "Agent notes"), titles)
        self.assertIn(("skills", "docker"), titles)
        self.assertNotIn("_root", first)

    def test_walk_budget(self):
        walked = model.walk_notes(self.home / "skills", budget=2)
        self.assertTrue(walked["partial"])

    def test_missing_folder(self):
        sites = [dict(self.sites[0], path=str(self.tmp / "nope"))]
        m = model.overview(sites, BASE, self.home)
        self.assertFalse(m["sites"][0]["present"])
        self.assertEqual(m["recent"], [])
        self.assertIsNone(m["memory"])

    def test_memory_kind_without_hermes_home(self):
        self.assertEqual(model.site_kind(self.home / "memories", None), "memory")
        self.assertEqual(model.site_kind(self.tmp / "vault", None), "vault")
        self.assertEqual(model.site_kind(self.tmp / "vault", None, "skills"), "skills")


if __name__ == "__main__":
    unittest.main()
