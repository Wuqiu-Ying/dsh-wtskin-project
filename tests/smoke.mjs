import { mkdtemp, rm, readFile, access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const python = process.argv[2] ?? 'python';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABC0lEQVR4nO3bwWHDIBBE0eHXlwpcYCpIf87dFwPaBaHZd8aaWYR9kSyVUkopxVVbHfj6e7+/rfn9act6tTsMvHND2p0HX7ER7YTBMzcCHTZ8dE47afCM08DJw0fkszM8ypUe7AjNMNuHlWHZZnohczzl7s/2I/Piu4z0ROZ42t0f7YvM8cS7P9IbmUPmkDme+v3v7Y/MIXPIHDKHzCFzyBwyx50eVGb41h+ZQ+aQOXoWnfo70NMbmaN34WmnoLcvMsfI4lNOwUhPMi++w2g/ZI6ZD931FMz0YmVYptk+7AiNdqUHO8MjXM1vcVXWPkOI2ngUaNVpiMxpSmL7rvAn27fFT/m/QCmllCJf/5hudFqf/uxRAAAAAElFTkSuQmCC', 'base64');
const tools = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  systemPrompt: { section: () => {} },
  logger: { warn: (m) => console.warn('[warn]', m) },
  effect: () => {},
};
apply(ctx, { pythonPath: python });

const need = ['dsh_wtskin_project','dsh_wtskin_layer','dsh_wtskin_export','dsh_wtskin_presets','dsh_wtskin_measure'];
for (const n of need) if (!tools.has(n)) throw new Error('missing ' + n);
console.log('tools ok:', [...tools.keys()].join(', '));

const dir = await mkdtemp(path.join(os.tmpdir(), 'wtskin-'));
const imageFile = path.join(dir, 'char.png');
await writeFile(imageFile, PNG);
try {
  await tools.get('dsh_wtskin_project').execute({ dir, action: 'create', data: { quadScale: 2.56, width: 2048, height: 2048 } });
  const msg = await tools.get('dsh_wtskin_measure').execute({ dir, id: 'wing', scale: 2.56 });
  const url = msg.match(/http:\/\/\S+/)[0];
  console.log('measure url:', url);

  const page = await (await fetch(url)).text();
  if (!page.includes('四边形取点')) throw new Error('page missing quad UI');
  const post = await fetch(new URL('/api/quad', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, id: 'wing', image: imageFile, quad: [[10,20],[30,40],[50,60],[70,80]], scale: 2.56 }),
  });
  if (!post.ok) throw new Error('save failed: ' + await post.text());
  const project = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'));
  const layer = project.layers.find((l) => l.id === 'wing');
  if (!layer || layer.quadScale !== 2.56) throw new Error('layer not saved');
  console.log('measure save ok, quad:', JSON.stringify(layer.quad));

  const out = await tools.get('dsh_wtskin_export').execute({ dir, pythonPath: python });
  const parsed = JSON.parse(out.slice(out.indexOf('{')));
  for (const k of ['png','dds','blk']) await access(parsed[k]);
  console.log('export ok:', parsed.png);
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.exit(0);
