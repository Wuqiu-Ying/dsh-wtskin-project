/**
 * Generates the per-project picker page.
 *
 * The page is a plain HTML file the user opens from DSH's file preview (right
 * sidebar). It cannot talk back to DSH, so it prints the quads as a copyable
 * block — version M of the workflow. The postMessage bridge is deliberately
 * absent: it is scheduled for v3.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(here, '..', 'assets', 'picker.html');
const PLACEHOLDER = '__WTSKIN_CONFIG__';

export function pickerConfig(dir, project) {
  return {
    project: dir,
    width: Number(project.width) || 4096,
    height: Number(project.height) || 4096,
    textureName: project.output?.textureName || 'skin_c',
    faces: (project.layers ?? []).map((layer) => ({ id: layer.id, quad: layer.quad })),
  };
}

export async function writePicker(dir, project) {
  const template = await fs.readFile(TEMPLATE, 'utf8');
  const json = JSON.stringify(pickerConfig(dir, project)).replace(/</g, '\\u003c');
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`picker template is missing ${PLACEHOLDER}`);
  }
  const file = path.join(dir, 'picker.html');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, template.replace(PLACEHOLDER, json), 'utf8');
  return file;
}
