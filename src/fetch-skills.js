'use strict';
// `npm run skills`: fetch (or update) the Obsidian agent skills that the editor's agents use —
// github.com/kepano/obsidian-skills — into agent-skills/obsidian-skills. Run it again to update.
// Needs git. A different repository or folder: `npm run skills -- <repo-url> <folder>`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SKILLS_REPO, DEFAULT_SKILLS_DIR, loadSkills } = require('./agents');

const repo = process.argv[2] || SKILLS_REPO;
const dir = path.resolve(process.argv[3] || DEFAULT_SKILLS_DIR);
const git = (args, cwd) => spawnSync('git', args, { cwd, stdio: 'inherit', windowsHide: true });

let r;
if (fs.existsSync(path.join(dir, '.git'))) {
  console.log(`Updating ${dir}`);
  r = git(['pull', '--ff-only'], dir);
} else {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  console.log(`Fetching ${repo} into ${dir}`);
  r = git(['clone', '--depth', '1', repo, dir]);
}
if (r.error || r.status !== 0) { console.error(r.error ? r.error.message : `git exited ${r.status}`); process.exit(1); }
const { skills } = loadSkills([dir], m => console.warn(m));
console.log(`${skills.length} skills: ${skills.map(s => s.name).join(', ')}`);
if (dir !== DEFAULT_SKILLS_DIR) console.log(`Point the config at it: "agents": { "skills": [${JSON.stringify(dir)}] }`);
