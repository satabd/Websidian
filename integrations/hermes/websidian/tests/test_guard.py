import io
import json
import os
import shutil
import sys
import tempfile
import unittest

from tests import PLUGIN_DIR  # noqa: F401  (sets sys.path)
import guard


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websidian-test-")
        self.home = os.path.join(self.tmp, "hermes-home")
        self.vault = os.path.join(self.tmp, "My Vault")
        self.elsewhere = os.path.join(self.tmp, "project")
        for d in (self.home, self.vault, self.elsewhere, os.path.join(self.home, "skills", "x")):
            os.makedirs(d, exist_ok=True)
        self.settings = guard.Settings(
            vaults=[{"path": self.vault, "url": "https://brain.example.com/hermes"}],
            hermes_homes=[self.home])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class ProtectedFiles(GuardCase):
    def test_protected_in_hermes_home(self):
        d = guard.evaluate("write_file", {"path": os.path.join(self.home, "SOUL.md"), "content": "x"}, self.settings)
        self.assertEqual(d["action"], "approve")
        self.assertIn("agent instruction file", d["message"])
        self.assertIn("human must approve", d["message"])

    def test_case_insensitive_nested(self):
        path = os.path.join(self.home, "skills", "x", "skill.MD")
        d = guard.evaluate("write_file", {"path": path, "content": "x"}, self.settings)
        self.assertEqual(d["action"], "approve")

    def test_protected_in_vault(self):
        d = guard.evaluate("write_file", {"path": os.path.join(self.vault, "sub", "Agents.md"), "content": "hi"}, self.settings)
        self.assertEqual(d["action"], "approve")

    def test_relative_path(self):
        d = guard.evaluate("write_file", {"path": os.path.join("..", "hermes-home", "MEMORY.md"), "content": "x"},
                           self.settings, base=self.elsewhere)
        self.assertIsNotNone(d)
        self.assertEqual(d["action"], "approve")
        d = guard.evaluate("write_file", {"path": "USER.md", "content": "x"}, self.settings, base=self.vault)
        self.assertEqual(d["action"], "approve")

    def test_tilde_path(self):
        fake_home = self.tmp
        old = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
        os.environ["HOME"] = fake_home
        os.environ["USERPROFILE"] = fake_home
        try:
            settings = guard.Settings(vaults=[], hermes_homes=[os.path.join(fake_home, "hermes-home")])
            d = guard.evaluate("write_file", {"path": "~/hermes-home/TOOLS.md", "content": "x"}, settings)
            self.assertEqual(d["action"], "approve")
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_outside_scope_not_protected(self):
        self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.elsewhere, "SKILL.md"), "content": "x"}, self.settings))

    def test_unprotected_name_in_home(self):
        self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.home, "notes.md"), "content": "x"}, self.settings))

    def test_block_mode(self):
        s = guard.Settings(vaults=[], hermes_homes=[self.home], protect_mode="block")
        d = guard.evaluate("write_file", {"path": os.path.join(self.home, "SOUL.md"), "content": "x"}, s)
        self.assertEqual(d["action"], "block")
        self.assertTrue(d["message"])

    @unittest.skipUnless(hasattr(os, "symlink"), "no symlinks")
    def test_symlink_into_protected(self):
        target = os.path.join(self.home, "SOUL.md")
        open(target, "w").close()
        link = os.path.join(self.elsewhere, "innocent.txt")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation not permitted")
        d = guard.evaluate("write_file", {"path": link, "content": "x"}, self.settings)
        self.assertEqual(d["action"], "approve")

    def test_patch_replace_and_v4a(self):
        d = guard.evaluate("patch", {"path": os.path.join(self.home, "SOUL.md"), "old_string": "a", "new_string": "b"}, self.settings)
        self.assertEqual(d["action"], "approve")
        patch = "*** Begin Patch\n*** Update File: %s\n@@\n-a\n+b\n*** End Patch" % os.path.join(self.home, "AGENTS.md")
        d = guard.evaluate("patch", {"mode": "patch", "patch": patch}, self.settings)
        self.assertEqual(d["action"], "approve")

    def test_custom_glob_pattern(self):
        s = guard.Settings(vaults=[], hermes_homes=[self.home], protect=["*.rules"])
        d = guard.evaluate("write_file", {"path": os.path.join(self.home, "team.RULES"), "content": ""}, s)
        self.assertEqual(d["action"], "approve")


class ActiveContent(unittest.TestCase):
    POSITIVE = {
        "script": "Hello\n<script>alert(1)</script>\n",
        "script mixed case": "<ScRiPt src=//evil.example></sCrIpT>",
        "onerror": 'An image <img src="x" onerror="alert(1)"> here',
        "onerror quoted gt": '<img alt=">" onerror=alert(1)>',
        "javascript markdown link": "[click me](javascript:alert(1))",
        "javascript spaced": "[click](  JaVaScRiPt:alert(1))",
        "entity javascript": "[x](java&#x09;script:alert(1))",
        "entity javascript attr": '<a href="&#106;&#97;vascript:alert(1)">x</a>',
        "entity colon": "[x](javascript&colon;alert(1))",
        "iframe": '<iframe src="https://evil.example"></iframe>',
        "svg onload": "<svg/onload=alert(1)>",
        "svg onload spaced": '<svg width="10" onload="alert(1)"></svg>',
        "object": "<object data=x></object>",
        "embed": "<embed src=x>",
        "meta refresh": '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        "base": '<base href="https://evil.example/">',
        "form": '<form action="https://evil.example"><input></form>',
        "data html": "[x](data:text/html;base64,PHNjcmlwdD4=)",
        "vbscript": '<a href="vbscript:msgbox(1)">x</a>',
        "reference definition": "[x]: javascript:alert(1)\n\n[click][x]",
        "unclosed fence": "```\n<script>alert(1)</script>\n",
        "fence inside html block": "<div>\n```\n<script>alert(1)</script>\n```\n</div>",
        "code span inside tag attr": '<a href="`javascript:alert(1)`">x</a>',
        "details ontoggle": "<details open ontoggle=alert(1)>",
        # Tricks that make a code-looking region render as HTML:
        "fence ends with list item": "- item\n  ```\n<script>alert(1)</script>\n  ```\n",
        "fence after comment block": "<!--\n\n```\n-->\n<script>alert(1)</script>\n```\n",
        "fence inside math block": "$$\n```\n$$\n<script>alert(1)</script>\n```\n",
        "fence inside frontmatter": "---\na: |\n```\n---\n<script>alert(1)</script>\n```\n",
        "tag across lines in quote": '> Click <a\n> href="`javascript:alert(1)`">x</a>',
        "tag across lines": 'Click <a\nhref="`javascript:alert(1)`">x</a>',
        "quoted gt before span": "<a title='>' href=\"`javascript:alert(1)`\">x</a>",
        "escaped backtick": "\\`<script>alert(1)</script>\\`",
        "table cell split": "| a | b |\n|---|---|\n| `x | <script>alert(1)</script>` |\n",
        "highlight swallows backtick": "==`== <script>alert(1)</script>`",
        "wikilink swallows backtick": "[[`]] <script>alert(1)</script>`",
        "math swallows backtick": "$`$ <script>alert(1)</script>`",
        "odd tag name": "<div>\n<x&y onmouseover=alert(1)>\n</div>",
        "tag inside other tag's quote": '<x& title="<img src=x onerror=alert(1)>">',
        "long attribute padding": '<img alt="' + "x" * 6000 + '" onerror=alert(1)>',
    }
    NEGATIVE = {
        "plain markdown": "---\ntitle: Note\ntags: [a, b]\nupdated: 2026-09-13\n---\n# Heading\n\nSome **bold** and a [link](https://example.com).\n\n- item\n- [ ] task\n",
        "callout": "> [!note] Title\n> Callout body with a [[Wikilink]].\n",
        "wikilinks": "See [[Other Note]], [[Folder/Note|alias]] and ![[image.png|300]].",
        "fenced script": "Example:\n\n```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```\n\nDone.",
        "tilde fence": "~~~\n<iframe src=x></iframe>\n~~~\n",
        "inline code": "Use `<script>` tags carefully and never `onerror=` or `javascript:alert(1)`.",
        "double backtick code": "Code: `` <script>`x`</script> `` ok",
        "prose javascript": "JavaScript is a language. I wrote javascript today, see the JavaScript docs.",
        "comparisons": "if a < b and one = 1 then x > y",
        "autolink": "<https://example.com/?one=1&two=2>",
        "html allowed tags": "<details><summary>More</summary>Hidden text</details>\n<kbd>Ctrl</kbd>",
        "http link": "[site](https://example.com/javascript/page)",
        "math": "$a<b$ and $$x > y$$",
        "task with code": "- [ ] replace `<iframe>` embeds with links\n- [x] done",
        "callout with code": "> [!warning] Careful\n> Never paste `<script>` or `onload=` into notes.",
        "comparison then long text": "if a<b then " + "x" * 5000 + " fine",
        "frontmatter": "---\ntitle: A\ntags: [x]\n---\nBody `<script>`\n",
    }

    def test_large_documents_are_fast(self):
        import time
        docs = ["Text with [[link]] and `code <b>` here.\n" * 20000, "<a '" * 100000, "a<b " * 200000,
                "`` " * 200000, "```\nx\n" * 50000, "$$\n" * 100000]
        for doc in docs:
            start = time.monotonic()
            guard.find_active_content(doc)
            self.assertLess(time.monotonic() - start, 10, doc[:20])

    def test_true_positives(self):
        for name, text in self.POSITIVE.items():
            with self.subTest(name):
                self.assertTrue(guard.find_active_content(text), f"not detected: {name}")

    def test_true_negatives(self):
        for name, text in self.NEGATIVE.items():
            with self.subTest(name):
                self.assertEqual(guard.find_active_content(text), [], f"false positive: {name}")


class VaultWrites(GuardCase):
    def test_block_active_note(self):
        d = guard.evaluate("write_file", {"path": os.path.join(self.vault, "a.md"), "content": "<script>x</script>"}, self.settings)
        self.assertEqual(d["action"], "block")
        self.assertIn("plain Obsidian Markdown", d["message"])

    def test_allow_plain_note(self):
        self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.vault, "a.md"), "content": "# Hi\n[[b]]"}, self.settings))

    def test_active_outside_vault_allowed(self):
        self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.elsewhere, "index.html"), "content": "<script>x</script>"}, self.settings))

    def test_blocked_extensions(self):
        for name in ("page.html", "x.HTM", "logo.svg", "doc.xhtml", "feed.xml", "app.js"):
            with self.subTest(name):
                d = guard.evaluate("write_file", {"path": os.path.join(self.vault, "sub", name), "content": ""}, self.settings)
                self.assertIsNotNone(d)
                self.assertEqual(d["action"], "block")
        for name in ("note.md", "image.png", "data.csv"):
            with self.subTest(name):
                self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.vault, name), "content": "ok"}, self.settings))

    def test_block_active_content_disabled(self):
        s = guard.Settings(vaults=[{"path": self.vault, "url": ""}], hermes_homes=[self.home], block_active_content=False)
        self.assertIsNone(guard.evaluate("write_file", {"path": os.path.join(self.vault, "a.md"), "content": "<script>"}, s))

    def test_patch_new_string(self):
        path = os.path.join(self.vault, "n.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("# Title\nbody\n")
        d = guard.evaluate("patch", {"path": path, "old_string": "body", "new_string": "<iframe src=x>"}, self.settings)
        self.assertEqual(d["action"], "block")
        self.assertIsNone(guard.evaluate("patch", {"path": path, "old_string": "body", "new_string": "new body"}, self.settings))

    def test_patch_splices_tag(self):
        path = os.path.join(self.vault, "splice.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("text <scr MARK\n")
        d = guard.evaluate("patch", {"path": path, "old_string": " MARK", "new_string": "ipt>alert(1)</script>"}, self.settings)
        self.assertEqual(d["action"], "block")

    def test_patch_existing_html_untouched(self):
        path = os.path.join(self.vault, "legacy.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("<iframe src=x></iframe>\n\nold text\n")
        self.assertIsNone(guard.evaluate("patch", {"path": path, "old_string": "old text", "new_string": "new text"}, self.settings))

    def test_v4a_add_file(self):
        patch = ("*** Begin Patch\n*** Add File: %s\n+# Note\n+<img src=x onerror=alert(1)>\n*** End Patch"
                 % os.path.join(self.vault, "new.md"))
        d = guard.evaluate("patch", {"mode": "patch", "patch": patch}, self.settings)
        self.assertEqual(d["action"], "block")
        patch = "*** Begin Patch\n*** Add File: %s\n+hello\n*** End Patch" % os.path.join(self.vault, "evil.svg")
        self.assertEqual(guard.evaluate("patch", {"mode": "patch", "patch": patch}, self.settings)["action"], "block")

    def test_written_paths(self):
        patch = "*** Begin Patch\n*** Add File: a.md\n+x\n*** Move File: b.md -> c.md\n*** Delete File: d.md\n*** End Patch"
        self.assertEqual(guard.written_paths("patch", {"mode": "patch", "patch": patch}), ["a.md", "c.md"])
        self.assertEqual(guard.written_paths("write_file", {"path": "x.md", "content": ""}), ["x.md"])


class ShellCommands(GuardCase):
    def test_redirect_to_protected(self):
        d = guard.evaluate("terminal", {"command": "echo hi >> ~/.hermes/SOUL.md"}, self.settings)
        self.assertEqual(d["action"], "approve")

    def test_sed_into_vault(self):
        cmd = 'sed -i "s/a/b/" "%s"' % os.path.join(self.vault, "note.md")
        self.assertEqual(guard.evaluate("terminal", {"command": cmd}, self.settings)["action"], "approve")

    def test_cp_forward_slashes(self):
        cmd = "cp /tmp/x.html '%s/x.html'" % self.vault.replace("\\", "/")
        self.assertIsNotNone(guard.evaluate("terminal", {"command": cmd}, self.settings))

    def test_workdir_inside_vault(self):
        self.assertIsNotNone(guard.evaluate("terminal", {"command": "echo x > page.html", "workdir": self.vault}, self.settings))

    def test_read_only_commands_allowed(self):
        self.assertIsNone(guard.evaluate("terminal", {"command": "cat '%s/note.md'" % self.vault}, self.settings))
        self.assertIsNone(guard.evaluate("terminal", {"command": "grep -r SKILL.md ."}, self.settings))
        self.assertIsNone(guard.evaluate("terminal", {"command": "echo hi > /tmp/out.txt"}, self.settings, base=self.elsewhere))

    def test_block_mode(self):
        s = guard.Settings(vaults=self.settings.vaults, hermes_homes=[self.home], protect_mode="block")
        self.assertEqual(guard.evaluate("terminal", {"command": "tee AGENTS.md < x"}, s)["action"], "block")


class SettingsSources(unittest.TestCase):
    def test_env_fallback(self):
        env = {"WEBSIDIAN_VAULTS": "/v1|https://a.example/x;/v2|https://b.example/y/",
               "WEBSIDIAN_PROTECT_MODE": "block", "WEBSIDIAN_PROTECT": "A.md, B.md",
               "WEBSIDIAN_BLOCK_ACTIVE_CONTENT": "false"}
        s = guard.settings_from_sources(None, env, hermes_homes=[])
        self.assertEqual([v["url"] for v in s.vaults], ["https://a.example/x/", "https://b.example/y/"])
        self.assertEqual(s.protect_mode, "block")
        self.assertEqual(s.protect, ["A.md", "B.md"])
        self.assertFalse(s.block_active_content)

    def test_config_wins(self):
        cfg = {"vaults": [{"path": "/v", "url": "https://c.example/"}], "protect_mode": "approve"}
        s = guard.settings_from_sources(lambda k, d: cfg.get(k, d), {"WEBSIDIAN_PROTECT_MODE": "block"}, hermes_homes=[])
        self.assertEqual(s.vaults[0]["url"], "https://c.example/")
        self.assertEqual(s.protect_mode, "approve")
        self.assertIn("SKILL.md", s.protect)
        self.assertTrue(s.block_active_content)

    def test_json_env(self):
        s = guard.settings_from_sources(None, {"WEBSIDIAN_VAULTS": json.dumps([{"path": "/v", "url": "u"}])}, hermes_homes=[])
        self.assertEqual(s.vaults[0]["url"], "u/")


class ShellHookCli(GuardCase):
    def _config(self):
        path = os.path.join(self.tmp, "cfg.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"vaults": [{"path": self.vault, "url": "https://brain.example.com/hermes/"}]}, fh)
        return path

    def _payload(self, tool_name, tool_input):
        return json.dumps({"hook_event_name": "pre_tool_call", "tool_name": tool_name, "tool_input": tool_input,
                           "session_id": "s1", "cwd": self.elsewhere, "profile": "default", "extra": {}})

    def test_block_bad_write(self):
        out = io.StringIO()
        code = guard.main(["--stdin", "--config", self._config()],
                          stdin=io.StringIO(self._payload("write_file", {"path": os.path.join(self.vault, "x.md"),
                                                                         "content": "<script>alert(1)</script>"})),
                          stdout=out, env={})
        self.assertEqual(code, 2)
        data = json.loads(out.getvalue())
        self.assertEqual(data["action"], "block")
        self.assertIn("active HTML", data["message"])

    def test_allow_good_write(self):
        out = io.StringIO()
        code = guard.main(["--stdin", "--config", self._config()],
                          stdin=io.StringIO(self._payload("write_file", {"path": os.path.join(self.vault, "x.md"), "content": "# ok"})),
                          stdout=out, env={})
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), "")

    def test_subprocess(self):
        import subprocess
        payload = self._payload("write_file", {"path": os.path.join(self.vault, "y.md"), "content": "[x](javascript:alert(1))"})
        proc = subprocess.run([sys.executable, os.path.join(PLUGIN_DIR, "guard.py"), "--stdin", "--config", self._config()],
                              input=payload, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["action"], "block")

    def test_non_tool_event_ignored(self):
        out = io.StringIO()
        code = guard.main(["--stdin"], stdin=io.StringIO(json.dumps({"hook_event_name": "pre_llm_call"})), stdout=out, env={})
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
