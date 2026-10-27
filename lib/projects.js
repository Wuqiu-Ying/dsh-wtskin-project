/**
 * WTSP project layout.
 *
 * <session working directory>/WTSP/<vehicle>_<custom name>/
 *
 * The WTSP root is shared by every skin. It is created on the first write, and
 * an existing one is reused. A subdirectory never overwrites an existing
 * project: a collision gets -2, -3, …
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeName(value, fallback = 'skin') {
  const text = String(value ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 60)
    .trim();
  return text || fallback;
}

export function projectRoot(cwd) {
  return path.join(cwd, 'WTSP');
}

export async function ensureProjectDir(cwd, { vehicle, name } = {}) {
  const root = projectRoot(cwd);
  const stat = await fs.stat(root).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new Error(`${root} exists but is not a directory; move it away and retry`);
  }
  await fs.mkdir(root, { recursive: true });

  const base = `${sanitizeName(vehicle, 'vehicle')}_${sanitizeName(name, 'skin')}`;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const dir = path.join(root, candidate);
    try {
      await fs.mkdir(dir);
      return { dir, root };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('cannot allocate a project directory');
}

export async function listProjects(cwd) {
  const root = projectRoot(cwd);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}
