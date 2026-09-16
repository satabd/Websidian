import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import urlsplit

from tests import PLUGIN_DIR  # noqa: F401  (sets sys.path)
import links
import sites


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


# --------------------------------------------------------------------------------------------------
# Dashboard deep links, and the login redirect they have to survive
# --------------------------------------------------------------------------------------------------

def _hermes_source_root():
    """A native Hermes checkout with the dashboard auth gate in it, or ``""``."""
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    for root in (os.environ.get("HERMES_AGENT_SRC", ""),
                 os.path.join(local, "hermes", "hermes-agent"),
                 os.path.join(os.path.expanduser("~"), ".hermes", "hermes-agent")):
        if root and os.path.isfile(os.path.join(root, "hermes_cli", "dashboard_auth", "routes.py")):
            return root
    return ""


HERMES_SRC = _hermes_source_root()

# The login round trip, run against Hermes's own functions: the gate percent-encodes "path?query" into
# /login?next=..., the HTTP layer decodes that query value, and _validate_post_login_target unquotes it a
# second time - which is what eats the escapes of a plain note= link.
_ROUNDTRIP = r"""
import json, sys, types
from urllib.parse import parse_qs, urlsplit
sys.path.insert(0, sys.argv[1])
from hermes_cli.dashboard_auth.middleware import _safe_next_target
from hermes_cli.dashboard_auth.routes import _validate_post_login_target

out = []
for url in json.loads(sys.stdin.read()):
    u = urlsplit(url)
    request = types.SimpleNamespace(url=types.SimpleNamespace(path=u.path, query=u.query))
    carried = parse_qs("next=" + _safe_next_target(request))["next"][0]
    out.append(_validate_post_login_target(carried))
sys.stdout.write(json.dumps(out))
"""


def _hermes_python():
    """The native install's own interpreter (it has fastapi), or ``""``."""
    for rel in (("venv", "Scripts", "python.exe"), ("venv", "bin", "python"),
                (".venv", "Scripts", "python.exe"), (".venv", "bin", "python")):
        path = os.path.join(HERMES_SRC, *rel)
        if HERMES_SRC and os.path.isfile(path):
            return path
    return ""


def hermes_login_targets(urls):
    """Where a browser lands after logging in, for each deep link - ``None`` when the native install cannot
    run here. Imported in-process when this interpreter has Hermes's dependencies, else in its venv."""
    if not HERMES_SRC:
        return None
    if HERMES_SRC not in sys.path:
        sys.path.insert(0, HERMES_SRC)
    try:
        from hermes_cli.dashboard_auth.middleware import _safe_next_target
        from hermes_cli.dashboard_auth.routes import _validate_post_login_target
    except Exception:  # fastapi/pydantic missing here: use the install's venv instead
        python = _hermes_python()
        if not python:
            return None
        try:
            proc = subprocess.run([python, "-c", _ROUNDTRIP, HERMES_SRC], input=json.dumps(urls),
                                  capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.SubprocessError):
            return None
        return json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else None
    import types
    from urllib.parse import parse_qs
    out = []
    for url in urls:
        u = urlsplit(url)
        request = types.SimpleNamespace(url=types.SimpleNamespace(path=u.path, query=u.query))
        carried = parse_qs("next=" + _safe_next_target(request))["next"][0]
        out.append(_validate_post_login_target(carried))
    return out


class DeepLinks(unittest.TestCase):
    BASE = "http://localhost:9119"
    # One name per character the plain encoding used to lose, plus a space and Arabic.
    NAMES = ["Notes/A & B", "C# notes/Über #1", "1 + 1", "50%20off", "My Note", "Projects/ملاحظة"]

    def test_plain_names_stay_readable(self):
        self.assertEqual(sites.note_query("Folder/Note.md"), "note=Folder/Note")
        self.assertEqual(sites.dashboard_note_url(self.BASE, "brain", "a/b.md"),
                         self.BASE + "/websidian?site=brain&note=a/b")
        self.assertEqual(sites.note_query("x!*'()~-_."), "note=x!*'()~-_.")

    def test_escaped_names_travel_as_base64(self):
        for name in self.NAMES:
            with self.subTest(name):
                url = sites.dashboard_note_url(self.BASE, "brain", name + ".md", edit=True)
                self.assertTrue(url.endswith("&edit=1"))
                query = urlsplit(url).query
                self.assertIn("note64=", query)
                self.assertEqual(sites.note_from_query(query), name)
                # base64url only: nothing in the value can be changed by a percent-decode.
                value = query.split("note64=", 1)[1].split("&", 1)[0]
                self.assertRegex(value, r"\A[A-Za-z0-9_-]+\Z")

    def test_old_plain_links_still_parse(self):
        self.assertEqual(sites.note_from_query("site=brain&note=Folder/My%20Note"), "Folder/My Note")
        self.assertEqual(sites.note_from_query("?note=a+b"), "a b")  # URLSearchParams reads "+" as a space
        self.assertEqual(sites.note_from_query("site=brain"), "")
        self.assertEqual(sites.note_from_query("note64=not base64!"), "")  # junk decodes to "", never raises

    def test_search_parameter(self):
        self.assertEqual(sites.search_query("focus=Note.md"), "q=focus=Note.md")
        self.assertEqual(sites.search_query("?focus=Note.md"), "q=focus=Note.md")
        for raw in ("focus=Plan%20%232.md", "a=1&b=2", "q=ملاحظة", "a=1+2"):
            with self.subTest(raw):
                built = sites.search_query(raw)
                self.assertTrue(built.startswith("q64="), built)
                self.assertEqual(sites.search_from_query(built), raw)
        self.assertEqual(sites.search_from_query("q=focus=a"), "focus=a")

    def test_frontend_accepts_both_forms(self):
        """dashboard/dist/index.js is hand-written: keep its half of the contract in sight."""
        with open(os.path.join(PLUGIN_DIR, "dashboard", "dist", "index.js"), encoding="utf-8") as fh:
            src = fh.read()
        for token in ('p.has("note64")', 'p.has("q64")', 'p.get("note")', 'p.get("q")',
                      '"note64=" + b64encode', '"q64=" + b64encode'):
            self.assertIn(token, src)

    @unittest.skipUnless(HERMES_SRC, "no native Hermes install found (set HERMES_AGENT_SRC)")
    def test_survives_the_real_login_redirect(self):
        new = [sites.dashboard_note_url("", "brain", name + ".md", edit=True) for name in self.NAMES]
        old = [f"/websidian?site=brain&note={sites.note_param(name)}&edit=1" for name in self.NAMES]
        targets = hermes_login_targets(new + old)
        if targets is None:
            self.skipTest("the native Hermes install's dependencies are not importable here")
        after_new, after_old = targets[:len(new)], targets[len(new):]
        for name, target in zip(self.NAMES, after_new):
            with self.subTest(name=name, link="note64"):
                self.assertTrue(target.startswith("/websidian?site=brain&"), target)
                query = urlsplit(target).query
                self.assertEqual(sites.note_from_query(query), name)
                self.assertIn("edit=1", query)
        # The encoding this replaced: "&", "#", "+" and a percent-escape do not come back intact.
        for name, target in zip(self.NAMES, after_old):
            if not any(ch in name for ch in "&#+%"):
                continue
            with self.subTest(name=name, link="note"):
                self.assertNotEqual(sites.note_from_query(urlsplit(target).query), name)


if __name__ == "__main__":
    unittest.main()
