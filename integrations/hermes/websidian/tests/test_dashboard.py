"""Dashboard extension: site slugs, generated Websidian config, secrets, proxy header/path rules, link styles."""

import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from tests import PLUGIN_DIR  # noqa: F401  (sets sys.path)
import guard
import links
import sites

_spec = importlib.util.spec_from_file_location("wsd_core_under_test", os.path.join(PLUGIN_DIR, "dashboard", "wsd_core.py"))
core = importlib.util.module_from_spec(_spec)
sys.modules["wsd_core_under_test"] = core
_spec.loader.exec_module(core)


class Slugs(unittest.TestCase):
    def test_slug_sources_and_uniqueness(self):
        vaults = sites.normalize_vaults([
            {"path": "/root/Documents/Obsidian Vault"},
            {"path": "/x/notes", "url": "https://brain.example.com/hermes/"},
            {"path": "/y/Notes", "slug": "Hermes"},
            {"path": "/z/obsidian vault"},
            {"path": "/w/_private"},
            {"path": "C:\\Users\\me\\Vault\\"},
            {"path": ""}, "junk", {"url": "https://x/"},
        ])
        self.assertEqual([v["slug"] for v in vaults],
                         ["obsidian-vault", "hermes", "hermes-2", "obsidian-vault-2", "private", "vault"])

    def test_defaults(self):
        v = sites.normalize_vaults([{"path": "/a/b"}])[0]
        self.assertTrue(v["untrusted"])
        self.assertFalse(v["edit"])          # browser editing is opt-in per vault
        self.assertEqual(v["title"], "b")
        self.assertTrue(sites.normalize_vaults([{"path": "/a/b", "edit": True}])[0]["edit"])
        self.assertTrue(sites.normalize_vaults([{"path": "/a/b", "edit": "yes"}])[0]["edit"])
        v = sites.normalize_vaults([{"path": "/a/b", "untrusted": "no", "edit": False, "title": "T"}])[0]
        self.assertFalse(v["untrusted"])
        self.assertFalse(v["edit"])
        self.assertEqual(v["title"], "T")
        # garbage never turns untrusted off
        self.assertTrue(sites.normalize_vaults([{"path": "/a", "untrusted": "maybe"}])[0]["untrusted"])
        self.assertTrue(sites.normalize_vaults([{"path": "/a", "untrusted": None}])[0]["untrusted"])

    def test_dashboard_settings(self):
        d = sites.dashboard_settings(None)
        self.assertFalse(d["configured"])
        self.assertEqual((d["port"], d["node"], d["public_base"]), (8095, "node", "http://localhost:9119"))
        d = sites.dashboard_settings({"port": "99999", "public_base": "https://h.example/hermes/"})
        self.assertTrue(d["configured"])
        self.assertEqual(d["port"], 8095)
        self.assertEqual(d["public_base"], "https://h.example/hermes")
        self.assertEqual(sites.websidian_base_path(d["public_base"]), "/hermes/api/plugins/websidian/w")
        self.assertEqual(sites.websidian_base_path("http://localhost:9119"), "/api/plugins/websidian/w")


class GeneratedConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="websidian-dash-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def runtime(self, settings):
        return core.resolve_runtime(settings, home=self.tmp)

    def test_config(self):
        rt = self.runtime({"vaults": [{"path": "/root/Documents/Obsidian Vault", "slug": "brain", "title": "Brain", "edit": True},
                                      {"path": "/root/.hermes/memories"}],
                           "dashboard": {"port": 8097, "public_base": "http://localhost:9119"}})
        self.assertEqual(rt["app_dir"], self.tmp / "plugin-data" / "websidian" / "app")
        secrets = core.load_or_create_secrets(rt["secrets_path"])
        cfg = core.build_config(rt, secrets)
        self.assertEqual(cfg["host"], "127.0.0.1")
        self.assertEqual(cfg["port"], 8097)
        self.assertEqual(cfg["basePath"], "/api/plugins/websidian/w")
        self.assertEqual(cfg["publicUrl"], "http://localhost:9119")
        self.assertFalse(cfg["warm"])
        self.assertEqual(cfg["cacheDir"], str(self.tmp / "plugin-data" / "websidian" / "cache"))
        pa = cfg["proxyAuth"]
        self.assertEqual(pa["secretHeader"], "x-websidian-proxy-secret")
        self.assertEqual(pa["userHeader"], "x-websidian-user")
        self.assertEqual(pa["allowFrom"], ["127.0.0.1", "::1"])
        self.assertGreaterEqual(len(pa["secret"]), 48)
        brain, mem = cfg["sites"]
        self.assertEqual((brain["slug"], brain["title"], brain["untrusted"]), ("brain", "Brain", True))
        self.assertEqual(brain["edit"]["allowFrom"], ["127.0.0.1", "::1"])
        self.assertEqual(brain["edit"]["secret"], secrets["edit_secret"])
        self.assertEqual(brain["auth"], {"token": secrets["site_token"]})
        self.assertEqual((mem["slug"], mem["edit"], mem["untrusted"]), ("memories", False, True))
        self.assertNotEqual(pa["secret"], secrets["edit_secret"])
        self.assertNotIn("agents", cfg, "the agent panel is off unless asked for")
        self.assertNotIn("agents", brain)

    def test_agents_setting(self):
        rt = self.runtime({"vaults": [{"path": "/v/brain", "slug": "brain"}, {"path": "/v/private", "slug": "private", "agents": False}],
                           "agents": True})
        cfg = core.build_config(rt, core.load_or_create_secrets(rt["secrets_path"]))
        self.assertEqual([a["id"] for a in cfg["agents"]["list"]], ["hermes", "claude", "codex"], "Hermes first")
        self.assertTrue(all(a["modes"] == ["review"] for a in cfg["agents"]["list"]))
        self.assertEqual(cfg["agents"]["sessionScope"], "vault")
        self.assertEqual(cfg["agents"]["stateFile"], str(self.tmp / "plugin-data" / "websidian" / "agent-sessions.json"))
        self.assertEqual([s["agents"] for s in cfg["sites"]], ["readers", False])
        # A list of its own: names or entries; an entry asking for edit still gets review only; unknown backends dropped.
        rt = self.runtime({"vaults": [{"path": "/v"}], "agents": {"list": ["hermes", {"id": "c", "backend": "claude-cli", "modes": ["edit"]},
                                                                            {"backend": "rm-rf"}], "sessionScope": "note"}})
        ag = core.build_config(rt, core.load_or_create_secrets(rt["secrets_path"]))["agents"]
        self.assertEqual([(a["id"], a["backend"], a["modes"]) for a in ag["list"]], [("hermes", "hermes-cli", ["review"]), ("c", "claude-cli", ["review"])])
        self.assertEqual(ag["sessionScope"], "note")
        # Claude Code and Codex use their OAuth sign-ins: inherited API keys are taken out; Hermes keeps its env.
        by_id = {a["id"]: a for a in core.agents_settings(True, self.tmp)["list"]}
        self.assertIn("ANTHROPIC_API_KEY", by_id["claude"]["envUnset"])
        self.assertIn("OPENAI_API_KEY", by_id["codex"]["envUnset"])
        self.assertNotIn("envUnset", by_id["hermes"])
        self.assertIsNone(core.agents_settings({"enabled": False}, self.tmp))
        self.assertIsNone(core.agents_settings({"list": [{"backend": "nope"}]}, self.tmp))

    def test_agent_cli_off_the_path(self):
        # hermes01: the dashboard's PATH lacks ~/.local/bin, where hermes, claude and codex live.
        from unittest import mock
        home = self.tmp / "home"
        (home / ".local" / "bin").mkdir(parents=True)
        cli = home / ".local" / "bin" / "hermes"
        cli.write_text("#!/bin/sh\n")
        cli.chmod(0o755)
        with mock.patch("shutil.which", return_value=None), mock.patch.object(core.Path, "home", return_value=home), \
                mock.patch.dict(os.environ, {"PATH": "/usr/bin"}), mock.patch("os.access", return_value=True):
            self.assertEqual(core.find_cli("hermes"), str(cli))
            self.assertEqual(core.find_cli("codex"), "")
            ag = core.agents_settings({"list": ["hermes", "codex"]}, self.tmp)
        hermes, codex = ag["list"]
        self.assertEqual(hermes["command"], str(cli))
        self.assertEqual(hermes["env"]["PATH"], "/usr/bin" + os.pathsep + str(cli.parent), "the agent gets the folder too")
        self.assertNotIn("command", codex, "not found: Websidian tries the bare name and leaves it out if it does not run")
        with mock.patch("shutil.which", return_value="/opt/x/claude"):
            ag = core.agents_settings({"list": [{"id": "c", "backend": "claude-cli", "command": ["docker", "exec", "box", "claude"]}]}, self.tmp)
        self.assertEqual(ag["list"][0]["command"], ["docker", "exec", "box", "claude"], "an explicit command is kept")

    def test_app_dir_setting(self):
        rt = self.runtime({"dashboard": {"app_dir": "~/wsd-app", "node": "/usr/bin/node"}})
        self.assertEqual(rt["app_dir"], Path(os.path.expanduser("~/wsd-app")))
        self.assertEqual(rt["node"], "/usr/bin/node")

    def test_secrets_persisted(self):
        path = self.tmp / "d" / "secrets.json"
        first = core.load_or_create_secrets(path)
        self.assertEqual(core.load_or_create_secrets(path), first)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        path.write_text(json.dumps({"proxy_secret": "short", "edit_secret": first["edit_secret"]}))
        again = core.load_or_create_secrets(path)
        self.assertNotEqual(again["proxy_secret"], "short")
        self.assertEqual(again["edit_secret"], first["edit_secret"])

    def test_change_detection(self):
        rt = self.runtime({"vaults": [{"path": "/v"}]})
        secrets = core.load_or_create_secrets(rt["secrets_path"])
        path = rt["config_path"]
        self.assertTrue(core.write_config_if_changed(path, core.build_config(rt, secrets)))
        self.assertFalse(core.write_config_if_changed(path, core.build_config(rt, secrets)))
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(json.loads(path.read_text())["sites"][0]["edit"], False)   # the default
        rt2 = self.runtime({"vaults": [{"path": "/v", "edit": True}]})
        self.assertTrue(core.write_config_if_changed(path, core.build_config(rt2, secrets)))
        self.assertEqual(json.loads(path.read_text())["sites"][0]["edit"]["allowFrom"], ["127.0.0.1", "::1"])
        self.assertEqual([p.name for p in path.parent.iterdir() if p.name.startswith(".")], [])  # no temp files left


class ProxyRules(unittest.TestCase):
    def test_request_headers(self):
        incoming = [("Cookie", "hermes_session_at=abc"), ("Authorization", "Bearer x"), ("Accept", "text/html"),
                    ("X-Websidian-Proxy-Secret", "forged"), ("x-websidian-user", "admin"), ("Content-Type", "application/json"),
                    ("X-Requested-With", "fetch"), ("Host", "evil"), ("X-Forwarded-For", "1.2.3.4"), ("If-None-Match", 'W/"1"'),
                    ("Range", "bytes=0-1"), ("User-Agent", "UA"), ("Accept-Language", "ar"), ("If-Modified-Since", "x"),
                    ("Accept-Encoding", "gzip"), ("Origin", "http://x")]
        out = core.filter_request_headers(incoming, "S" * 64, "sat<script>")
        names = [k for k, _ in out]
        for dropped in ("cookie", "authorization", "host", "x-forwarded-for", "origin"):
            self.assertNotIn(dropped, names)
        self.assertEqual(names.count("x-websidian-proxy-secret"), 1)
        self.assertEqual(names.count("x-websidian-user"), 1)
        d = dict(out)
        self.assertEqual(d["x-websidian-proxy-secret"], "S" * 64)
        self.assertEqual(d["x-websidian-user"], "satscript")
        self.assertEqual(d["accept-encoding"], "identity")
        for kept in ("accept", "content-type", "x-requested-with", "if-none-match", "range", "user-agent",
                     "accept-language", "if-modified-since"):
            self.assertIn(kept, d)
        self.assertEqual(dict(core.filter_request_headers([], "s", ""))["x-websidian-user"], "hermes")

    def test_response_headers(self):
        out = dict(core.filter_response_headers([
            ("Set-Cookie", "a=b"), ("Content-Type", "text/html"), ("Content-Security-Policy", "default-src 'self'"),
            ("ETag", "x"), ("Location", "/api/plugins/websidian/w/s/"), ("X-Render", "hit"), ("Server", "express"),
            ("X-Powered-By", "x"), ("Access-Control-Allow-Origin", "*"), ("Content-Disposition", "inline")]))
        self.assertNotIn("set-cookie", out)
        self.assertNotIn("access-control-allow-origin", out)
        self.assertNotIn("server", out)
        self.assertEqual(out["content-security-policy"], "default-src 'self'")
        self.assertEqual(out["location"], "/api/plugins/websidian/w/s/")
        self.assertIn("x-render", out)

    def test_upstream_target(self):
        base = "/api/plugins/websidian/w"
        t = core.upstream_target
        self.assertEqual(t(base + "/brain/My%20Note", "", base), base + "/brain/My%20Note")
        self.assertEqual(t(base + "/brain/_search", "q=a%20b", base), base + "/brain/_search?q=a%20b")
        self.assertEqual(t(base, "", base), base)
        self.assertIsNone(t("/api/plugins/other/x", "", base))
        self.assertIsNone(t(base + "x/y", "", base))
        for bad in ("/brain/../../../api/config", "/brain/%2e%2e/x", "/brain/.%2E/x", "/./x", "/brain/a%2Fb",
                    "/brain/a%5cb", "/brain/a%00", "/brain/a\r\nX: y", "/brain/a b", "/brain/a\\b"):
            self.assertIsNone(t(base + bad, "", base), bad)
        self.assertIsNone(t(base + "/brain/x", "a=\nb", base))
        self.assertEqual(t("/hermes" + base + "/s/", "", "/hermes" + base), "/hermes" + base + "/s/")

    def test_error_page_escapes(self):
        page = core.error_page(502, "down", "<b>x</b>", ["<script>alert(1)</script>\n"], refresh=5)
        self.assertNotIn("<script>", page)
        self.assertIn('http-equiv="refresh" content="5"', page)


class LinkStyles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websidian-ls-")
        self.vault = os.path.join(self.tmp, "Obsidian Vault")
        os.makedirs(os.path.join(self.vault, "Projects"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def settings(self, **cfg):
        return guard.settings_from_sources(lambda k, d: cfg.get(k, d), env={}, hermes_homes=[])

    def entry(self, s, rel="Projects/Plan #2.md"):
        return links.links_for_path(os.path.join(self.vault, *rel.split("/")), s.vaults)

    def test_dashboard_style(self):
        s = self.settings(vaults=[{"path": self.vault, "slug": "brain", "edit": True}], link_style="dashboard",
                          dashboard={"public_base": "https://hermes.example.com/"})
        e = self.entry(s)
        # "Plan #2" needs percent-escaping, which a login redirect would eat: the note travels as base64url.
        note64 = sites.b64_param("Projects/Plan #2")
        self.assertEqual(e["view"], f"https://hermes.example.com/websidian?site=brain&note64={note64}")
        self.assertEqual(e["edit"], f"https://hermes.example.com/websidian?site=brain&note64={note64}&edit=1")
        self.assertEqual(s.vaults[0]["url"], "https://hermes.example.com/websidian?site=brain")

    def test_dashboard_style_read_only_vault_has_no_edit_link(self):
        """edit defaults to False, and the dashboard's own site would refuse the editor."""
        s = self.settings(vaults=[{"path": self.vault, "slug": "brain"}], link_style="dashboard",
                          dashboard={"public_base": "https://hermes.example.com/"})
        e = self.entry(s)
        self.assertEqual(e["view"],
                         "https://hermes.example.com/websidian?site=brain&note64=" + sites.b64_param("Projects/Plan #2"))
        self.assertEqual(e["edit"], "")
        self.assertNotIn("edit:", links.format_links_block([e]))

    def test_dashboard_default_when_dashboard_configured_and_no_url(self):
        s = self.settings(vaults=[{"path": self.vault}], dashboard={"port": 8095})
        self.assertEqual(self.entry(s, "a.md")["view"], "http://localhost:9119/websidian?site=obsidian-vault&note=a")

    def test_direct_style(self):
        s = self.settings(vaults=[{"path": self.vault, "slug": "brain"}], link_style="direct",
                          dashboard={"public_base": "http://localhost:9119"})
        e = self.entry(s, "Projects/été.md")
        self.assertEqual(e["view"], "http://localhost:9119/api/plugins/websidian/w/brain/Projects/%C3%A9t%C3%A9")
        self.assertEqual(e["edit"], "http://localhost:9119/api/plugins/websidian/w/brain/_edit/Projects/%C3%A9t%C3%A9")

    def test_explicit_url_kept_when_style_unset(self):
        s = self.settings(vaults=[{"path": self.vault, "url": "https://brain.example.com/hermes"}],
                          dashboard={"public_base": "http://localhost:9119"})
        self.assertEqual(self.entry(s, "a b.md")["view"], "https://brain.example.com/hermes/a%20b")
        s = self.settings(vaults=[{"path": self.vault, "url": "https://brain.example.com/hermes"}], link_style="dashboard")
        self.assertEqual(self.entry(s, "a b.md")["view"],
                         "http://localhost:9119/websidian?site=hermes&note64=" + sites.b64_param("a b"))

    def test_no_links_without_url_or_dashboard(self):
        s = self.settings(vaults=[{"path": self.vault}])
        e = self.entry(s, "a.md")
        self.assertEqual((e["view"], e["edit"]), ("", ""))

    def test_env_public_base(self):
        s = guard.settings_from_sources(None, env={"WEBSIDIAN_VAULTS": json.dumps([{"path": self.vault, "slug": "b"}]),
                                                   "WEBSIDIAN_PUBLIC_BASE": "http://h:9119", "WEBSIDIAN_LINK_STYLE": "dashboard"},
                                        hermes_homes=[])
        self.assertEqual(self.entry(s, "x.md")["view"], "http://h:9119/websidian?site=b&note=x")


class VersionStamps(unittest.TestCase):
    """The installers stamp both copies; the dashboard uses the stamps to spot a half-finished upgrade."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="websidian-stamp-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_read_version_stamp(self):
        self.assertIsNone(core.read_version_stamp(self.tmp / "nope.version"))   # a checkout has no stamp
        bad = self.tmp / "bad.version"
        bad.write_text("not json")
        self.assertIsNone(core.read_version_stamp(bad))
        not_a_dict = self.tmp / "list.version"
        not_a_dict.write_text("[1, 2]")
        self.assertIsNone(core.read_version_stamp(not_a_dict))
        good = self.tmp / core.VERSION_FILE
        good.write_text(json.dumps({"revision": "a55bcf0", "component": "runtime"}))
        self.assertEqual(core.read_version_stamp(good)["revision"], "a55bcf0")

    def test_version_skew(self):
        a, b = {"revision": "a55bcf0"}, {"revision": "39ae9ba"}
        self.assertTrue(core.version_skew(a, b))
        self.assertFalse(core.version_skew(a, dict(a)))
        # Unknown on either side is not evidence of skew: a hand copy has no stamp.
        self.assertFalse(core.version_skew(a, None))
        self.assertFalse(core.version_skew(None, b))
        self.assertFalse(core.version_skew(a, {"revision": ""}))


if __name__ == "__main__":
    unittest.main()
