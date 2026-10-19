/**
 * Local static server for the quad picker.
 *
 * GET  /          the measurement page (assets/measure.html)
 * POST /api/quad  {dir, id, quad, scale, image} -> upsert a layer in <dir>/project.json
 *
 * Bound to 127.0.0.1 only. The page is opened with ?dir=&id=&scale= so the
 * "保存到工程" button knows where to write.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createMeasureServer({ htmlPath, host = '127.0.0.1' }) {
  let url = '';

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        const html = await readFile(htmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/quad') {
        const body = await readJson(req);
        const dir = path.resolve(String(body.dir || ''));
        const id = String(body.id || '');
        const quad = body.quad;
        if (!id) throw new Error('id is required');
        if (!Array.isArray(quad) || quad.length !== 4 || !quad.every(
          (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n))),
        )) throw new Error('quad must be 4 [x,y] points');

        const projectFile = path.join(dir, 'project.json');
        const project = JSON.parse(await readFile(projectFile, 'utf8'));
        project.layers = project.layers ?? [];
        const scale = Number(body.scale);
        const layer = {
          id,
          image: String(body.image || ''),
          quad: quad.map((p) => [Number(p[0]), Number(p[1])]),
          quadScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
          size: 'chord',
          factor: 1,
        };
        const index = project.layers.findIndex((l) => l.id === id);
        if (index >= 0) project.layers[index] = { ...project.layers[index], ...layer };
        else project.layers.push(layer);
        await writeFile(projectFile, JSON.stringify(project, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, id, layers: project.layers.length });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      url = `http://${host}:${port}`;
      resolve({
        url,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
