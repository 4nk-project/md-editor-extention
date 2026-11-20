import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist', { recursive: true });
const host = await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20', sourcemap: true, metafile: true });
const client = await build({ entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true, metafile: true });
await build({ entryPoints: ['src/webview/style.css'], outfile: 'dist/style.css', bundle: true });
const packages = new Set([...Object.keys(host.metafile.inputs), ...Object.keys(client.metafile.inputs)].map(p => p.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const notices = ['Third-party software included in the extension bundles.\n'];
for (const dir of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const file = (await readdir(dir)).find(f => /^licen[sc]e(?:\.|$)/i.test(f));
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version} (${pkg.license ?? 'see license'})\n${file ? await readFile(path.join(dir, file), 'utf8') : 'See package repository for license details.'}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n'));
