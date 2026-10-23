#!/usr/bin/env node
/**
 * Install dsh-wtskin-project into a DSH profile without the dsh CLI.
 *
 *   node install.mjs --profile desktop [--dry-run] [--python <path>] [--dsh-home C:\Users\me\.dsh]
 *
 * 1. copies the package into <dshHome>/profiles/<profile>/node_modules/dsh-wtskin-project
 * 2. backs up the profile's cordis.patch.yml once and appends the plugin row
 *
 * Prefer the DSH plugin manager: it resolves the profile the same way and keeps
 * one bundle row instead of copying files by hand.
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
const backup = `${patchFile}.bak-dsh-wtskin-project`;

const ROW = [
  '',
  '# dsh-wtskin-project v2 (added by install.mjs)',
  '- insert:',
  '    - id: dsh-wtskin-project',
  '      name: dsh-wtskin-project',
  ...(pythonPath ? ['      config:', `        pythonPath: ${JSON.stringify(pythonPath)}`] : []),
  '',
].join('\n');

const PACKAGE_FILES = ['lib', 'python', 'presets', 'assets', 'tests', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md'];

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

await mkdir(target, { recursive: true });
for (const entry of PACKAGE_FILES) {
  const from = path.join(here, entry);
  if (!(await exists(from))) continue;
  await cp(from, path.join(target, entry), { recursive: true, force: true });
}
console.log('copied package files');

const patch = (await exists(patchFile)) ? await readFile(patchFile, 'utf8') : '';
if (patch.includes('dsh-wtskin-project')) {
  console.log('cordis.patch.yml already references dsh-wtskin-project; nothing to add');
} else {
  if (!(await exists(backup))) await writeFile(backup, patch, 'utf8');
  await writeFile(patchFile, `${patch.replace(/\s*$/, '')}\n${ROW}`, 'utf8');
  console.log(`patched ${patchFile} (backup: ${path.basename(backup)})`);
}

console.log('\nDone. Restart DSH so the tools and the /wtskinp command register.');
