import os
import shutil
import tempfile
import time
import unittest

from tests import PLUGIN_DIR  # noqa: F401  (sets sys.path)
import links


class EncodeUriComponent(unittest.TestCase):
    def test_matches_javascript(self):
        # Expected values computed with JavaScript's encodeURIComponent.
        cases = {
            "My Note": "My%20Note",
            "a#b?c&d=e/f": "a%23b%3Fc%26d%3De%2Ff",
            "!~*'()-_.": "!~*'()-_.",
            "Café": "Caf%C3%A9",
            "ملاحظة": "%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A9",
            "\U0001F600": "%F0%9F%98%80",
            "100% [x] {y} +z,;:@$": "100%25%20%5Bx%5D%20%7By%7D%20%2Bz%2C%3B%3A%40%24",
        }
        for raw, expected in cases.items():
            with self.subTest(raw):
                self.assertEqual(links.encode_uri_component(raw), expected)


class NoteUrls(unittest.TestCase):
    BASE = "https://brain.example.com/hermes/"

    def test_view_and_edit(self):
        self.assertEqual(links.view_url(self.BASE, "Folder/Sub/My Note.md"), self.BASE + "Folder/Sub/My%20Note")
        self.assertEqual(links.edit_url(self.BASE, "Folder/Sub/My Note.md"), self.BASE + "_edit/Folder/Sub/My%20Note")

    def test_base_without_trailing_slash(self):
        self.assertEqual(links.view_url("https://x.example/s", "a.md"), "https://x.example/s/a")

    def test_hash_unicode(self):
        self.assertEqual(links.view_url(self.BASE, "C# notes/Über #1.md"), self.BASE + "C%23%20notes/%C3%9Cber%20%231")

    def test_backslashes_and_uppercase_ext(self):
        self.assertEqual(links.note_rel_to_url_path("a\\b c\\Note.MD"), "a/b%20c/Note")


class LinksForPath(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websidian-links-")
        self.vault = os.path.join(self.tmp, "Vault Root")
        os.makedirs(os.path.join(self.vault, "Projects", "été"), exist_ok=True)
        self.vaults = [{"path": self.vault, "url": "https://brain.example.com/hermes/"}]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_nested(self):
        e = links.links_for_path(os.path.join(self.vault, "Projects", "été", "Plan #2.md"), self.vaults)
        self.assertEqual(e["rel"], "Projects/été/Plan #2.md")
        self.assertEqual(e["view"], "https://brain.example.com/hermes/Projects/%C3%A9t%C3%A9/Plan%20%232")
        self.assertEqual(e["edit"], "https://brain.example.com/hermes/_edit/Projects/%C3%A9t%C3%A9/Plan%20%232")

    def test_relative(self):
        e = links.links_for_path(os.path.join("Projects", "a.md"), self.vaults, base=self.vault)
        self.assertEqual(e["rel"], "Projects/a.md")

    @unittest.skipUnless(os.name == "nt", "Windows path semantics")
    def test_windows_backslashes_and_case(self):
        path = self.vault.upper().replace("/", "\\") + "\\Projects\\Note.md"
        e = links.links_for_path(path, self.vaults)
        self.assertIsNotNone(e)
        self.assertEqual(e["view"], "https://brain.example.com/hermes/Projects/Note")
        e = links.links_for_path(self.vault.replace("\\", "/") + "/Projects/Other.md", self.vaults)
        self.assertEqual(e["rel"], "Projects/Other.md")

    def test_outside_or_not_note(self):
        self.assertIsNone(links.links_for_path(os.path.join(self.tmp, "x.md"), self.vaults))
        self.assertIsNone(links.links_for_path(os.path.join(self.vault, "img.png"), self.vaults))
        self.assertIsNone(links.links_for_path(os.path.join(self.vault, ".obsidian", "x.md"), self.vaults))
        self.assertIsNone(links.links_for_path(self.tmp + "/Vault Root Other/x.md", self.vaults))

    def test_recent_notes(self):
        names = ["old.md", "Projects/mid.md", "Projects/été/new note.md", ".trash/deleted.md", "img.png"]
        now = time.time()
        for i, name in enumerate(names):
            full = os.path.join(self.vault, *name.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write("x")
            os.utime(full, (now - 100 + i * 10, now - 100 + i * 10))
        notes = links.recent_notes(self.vaults)
        self.assertEqual([n["rel"] for n in notes], ["Projects/été/new note.md", "Projects/mid.md", "old.md"])
        self.assertEqual(notes[0]["view"], "https://brain.example.com/hermes/Projects/%C3%A9t%C3%A9/new%20note")
        self.assertEqual([n["rel"] for n in links.recent_notes(self.vaults, "MID")], ["Projects/mid.md"])
        self.assertEqual(len(links.recent_notes(self.vaults, limit=2)), 2)


if __name__ == "__main__":
    unittest.main()
