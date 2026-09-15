import importlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests import PLUGIN_DIR  # noqa: F401  (sets sys.path so the plugin imports as the package "websidian")

websidian = importlib.import_module(os.path.basename(PLUGIN_DIR))


class FakeCtx:
    """Mimics hermes_cli.plugins.PluginContext's registration surface."""

    def __init__(self, settings=None):
        self.settings = settings or {}
        self.hooks = {}
        self.tools = {}
        self.commands = {}
        self.skills = {}
        self.prompt_sections = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False,
                      description="", emoji="", override=False):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_command(self, name, handler, description="", args_hint="", argument_mode=None):
        self.commands[name] = {"handler": handler, "description": description}

    def register_skill(self, name, path, description="", frontmatter=None):
        assert isinstance(path, Path) and path.exists()
        self.skills[name] = path

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
        self.prompt_sections[id] = content


class MinimalCtx:
    """An older Hermes: hooks only."""

    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)


class RegisterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websidian-plugin-")
        self.vault = os.path.join(self.tmp, "vault")
        os.makedirs(os.path.join(self.vault, "Daily"))
        self.ctx = FakeCtx({"vaults": [{"path": self.vault, "url": "https://brain.example.com/hermes"}]})
        websidian.register(self.ctx)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def hook(self, name):
        return self.ctx.hooks[name][0]

    def test_registrations(self):
        self.assertEqual(set(self.ctx.hooks), {"pre_tool_call", "post_tool_call", "transform_llm_output"})
        self.assertIn("websidian_links", self.ctx.tools)
        self.assertEqual(self.ctx.tools["websidian_links"]["schema"]["name"], "websidian_links")
        self.assertIn("brain", self.ctx.commands)
        self.assertIn("websidian", self.ctx.skills)
        self.assertIn("websidian.vaults", self.ctx.prompt_sections)
        prompt = self.ctx.prompt_sections["websidian.vaults"]({})
        self.assertIn(self.vault, prompt)
        self.assertIn("websidian:websidian", prompt)

    def test_minimal_ctx(self):
        ctx = MinimalCtx()
        websidian.register(ctx)
        self.assertEqual(set(ctx.hooks), {"pre_tool_call", "post_tool_call", "transform_llm_output"})

    def test_pre_tool_call(self):
        pre = self.hook("pre_tool_call")
        d = pre(tool_name="write_file", args={"path": os.path.join(self.vault, "x.md"), "content": "<script>1</script>"},
                task_id="t", session_id="s")
        self.assertEqual(d["action"], "block")
        self.assertIsNone(pre(tool_name="write_file", args={"path": os.path.join(self.vault, "x.md"), "content": "ok"}, task_id="t"))
        self.assertIsNone(pre(tool_name="read_file", args={"path": "x"}, task_id="t"))

    def test_links_flow(self):
        path = os.path.join(self.vault, "Daily", "2026-09-13 Log.md")
        post = self.hook("post_tool_call")
        post(tool_name="write_file", args={"path": path, "content": "# log"}, result=json.dumps({"bytes_written": 5}),
             task_id="t", session_id="s1", status="ok")
        post(tool_name="write_file", args={"path": os.path.join(self.vault, "bad.md"), "content": "x"},
             result=json.dumps({"error": "disk full"}), task_id="t", session_id="s1", status="error")
        post(tool_name="write_file", args={"path": os.path.join(self.tmp, "elsewhere.md"), "content": "x"},
             result="{}", task_id="t", session_id="s1", status="ok")

        view = "https://brain.example.com/hermes/Daily/2026-09-13%20Log"
        out = json.loads(self.ctx.tools["websidian_links"]["handler"]({}, task_id="t", session_id="s1"))
        self.assertEqual([n["view"] for n in out["notes"]], [view])
        self.assertEqual(out["notes"][0]["edit"], "https://brain.example.com/hermes/_edit/Daily/2026-09-13%20Log")

        transform = self.hook("transform_llm_output")
        self.assertIsNone(transform(response_text="Done.", session_id="other"))
        text = transform(response_text="Done.", session_id="s1", model="m", platform="cli")
        self.assertTrue(text.startswith("Done."))
        self.assertIn("Notes updated:", text)
        self.assertIn(view, text)
        self.assertIsNone(transform(response_text="Again.", session_id="s1"))  # footer only once per change

        post(tool_name="patch", args={"path": path, "old_string": "a", "new_string": "b"}, result="{}",
             task_id="t", session_id="s1", status="ok")
        self.assertIsNone(transform(response_text=f"Updated {view}", session_id="s1"))  # agent already linked it

    def test_links_tool_paths(self):
        handler = self.ctx.tools["websidian_links"]["handler"]
        out = json.loads(handler({"paths": [os.path.join(self.vault, "A b.md"), "/nowhere/x.md"]}, task_id="t"))
        self.assertEqual(out["notes"][0]["view"], "https://brain.example.com/hermes/A%20b")
        self.assertEqual(out["not_in_vault"], ["/nowhere/x.md"])

    def test_brain_command(self):
        with open(os.path.join(self.vault, "Daily", "Alpha.md"), "w") as fh:
            fh.write("a")
        with open(os.path.join(self.vault, "Beta.md"), "w") as fh:
            fh.write("b")
        handler = self.ctx.commands["brain"]["handler"]
        listing = handler("")
        self.assertIn("https://brain.example.com/hermes/Daily/Alpha", listing)
        self.assertIn("https://brain.example.com/hermes/Beta", listing)
        filtered = handler("alp")
        self.assertIn("Alpha", filtered)
        self.assertNotIn("Beta", filtered)
        self.assertIn("No notes matching", handler("zzz"))

    def test_no_vaults_configured(self):
        ctx = FakeCtx({})
        old = os.environ.pop("WEBSIDIAN_VAULTS", None)
        try:
            websidian.register(ctx)
            self.assertIn("no vaults configured", ctx.commands["brain"]["handler"](""))
            self.assertIn("error", json.loads(ctx.tools["websidian_links"]["handler"]({})))
        finally:
            if old is not None:
                os.environ["WEBSIDIAN_VAULTS"] = old


if __name__ == "__main__":
    unittest.main()
