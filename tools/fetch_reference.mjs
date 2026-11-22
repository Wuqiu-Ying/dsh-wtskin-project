/**
 * WT Live reference fetcher (runs in a child process so it can honour the
 * system proxy through NODE_USE_ENV_PROXY).
 *
 *   node fetch_reference.mjs "<#tag>" <max> <outDir>
 *
 * Prints one JSON array: [{ id, language, downloads, author, description, zip, bytes }]
 * or [{ id, error }] per failed post.
 */
import fs from 'node:fs';
import path from 'node:path';

const [tags, maxArg, outDir] = process.argv.slice(2);
const max = Math.max(1, Math.min(3, Number(maxArg) || 2));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const feedBody = new URLSearchParams({
  type: 'regular',
  content: 'camouflage',
  sort: 'downloads',
  searchString: tags,
  page: '0',
  subtype: 'all',
});

const feed = await (await fetch('https://live.warthunder.com/api/feed/get_regular/', {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: feedBody,
})).json();

const list = Array.isArray(feed?.data?.list) ? feed.data.list : [];
const results = [];
for (const item of list.slice(0, max)) {
  const id = String(item.id);
  const language = String(item.language || 'en');
  try {
    const page = await (await fetch(`https://live.warthunder.com/post/${id}/${language}/`, { headers: { 'User-Agent': UA } })).text();
    const dl = page.match(/\/dl\/[a-f0-9]+\//i)?.[0];
    if (!dl) {
      results.push({ id, error: 'post page has no /dl/ link' });
      continue;
    }
    const res = await fetch(`https://live.warthunder.com${dl}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      results.push({ id, error: `download HTTP ${res.status}` });
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const zip = path.join(outDir, `${id}.zip`);
    fs.writeFileSync(zip, buffer);
    results.push({
      id,
      language,
      downloads: item.downloads ?? null,
      author: item.author?.nickname ?? null,
      description: String(item.description ?? '').slice(0, 200),
      zip,
      bytes: buffer.length,
    });
  } catch (error) {
    results.push({ id, error: String((error && error.message) || error) });
  }
}

console.log(JSON.stringify(results));
