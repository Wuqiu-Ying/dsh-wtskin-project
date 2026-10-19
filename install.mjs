#!/usr/bin/env node
/**
 * Install dsh-wtskin-project into a DSH profile without the dsh CLI.
 *
 *   node install.mjs --profile desktop [--dry-run] [--dsh-home C:\Users\me\.dsh]
 *
 * What it does:
 *   1. copies this package into <dshHome>/profiles/<profile>/node_modules/dsh-wtskin-project
 *   2. backs up the profile's cordis.patch.yml and appends the plugin row
 *
 * The plugin has no runtime dependencies of its own: `@deepseek-ai/dsh-tools`
 * is provided by the host, exactly like the bundled plugins.
 */
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const dryRun = args.includes('--dry-run');
const profile = option('profile', 'desktop');
const pythonPath = option('python', '');
const dshHome = option('dsh-home', path.join(os.homedir(), '.dsh'));
const profileDir = path.join(dshHome, 'profiles', profile);
const target = path.join(profileDir, 'node_modules', 'dsh-wtskin-project');
const patchFile = path.join(profileDir, 'cordis.patch.yml');

const ROW = [
  '',
  '# dsh-wtskin-project: War Thunder skin studio (added by install.mjs)',
  '- insert:',
  '    - id: dsh-wtskin-project',
  '      name: dsh-wtskin-project',
  ...(pythonPath ? ['      config:', `        pythonPath: ${JSON.stringify(pythonPath)}`] : []),
  '',
].join('\n');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

if (!(await exists(profileDir))) {
  console.error(`profile not found: ${profileDir}`);
  process.exit(1);
}

console.log(`profile: ${profileDir}`);
console.log(`target : ${target}`);

if (dryRun) {
  console.log('[dry-run] would copy the package and append the loader row');
  process.exit(0);
}

// 1. copy package files (no node_modules / tests / test fixtures)
await mkdir(target, { recursive: true });
for (const entry of ['lib', 'python', 'presets', 'assets', 'package.json', 'cordis.patch.yml', 'README.md']) {
  const from = path.join(here, entry);
  if (!(await exists(from))) continue;
  await cp(from, path.join(target, entry), { recursive: true, force: true });
}
console.log('copied package files');

// 2. patch the profile
const patch = (await exists(patchFile)) ? await readFile(patchFile, 'utf8') : '';
if (patch.includes('dsh-wtskin-project')) {
  console.log('cordis.patch.yml already references dsh-wtskin-project; nothing to add');
} else {
  await writeFile(`${patchFile}.bak-dsh-wtskin-project`, patch, 'utf8');
  await writeFile(patchFile, `${patch.replace(/\s*$/, '')}\n${ROW}`, 'utf8');
  console.log(`patched ${patchFile} (backup: ${path.basename(patchFile)}.bak-dsh-wtskin-project)`);
}

console.log('\nDone. Restart DSH so the tools register, then ask the agent to make a skin.');
