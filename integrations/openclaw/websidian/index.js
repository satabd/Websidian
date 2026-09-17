// websidian - connect OpenClaw to a Websidian site (an Obsidian vault served as a website). Entry point;
// everything it registers lives in lib/plugin.js (see the comment there and README.md).
import fs from 'node:fs';
import { registerWebsidian } from './lib/plugin.js';

// The manifest is the source of truth for the config schema; the entry carries the same schema so nothing drifts.
const manifest = JSON.parse(fs.readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));

// Shaped like definePluginEntry() from openclaw/plugin-sdk/plugin-entry, without importing the SDK so the plugin
// loads the same way from an installed package, a linked checkout and plugins.load.paths.
export default {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: manifest.configSchema,
  register(api) {
    registerWebsidian(api);
  },
};
