// Bundles the renderer's unit tests (markdown.tsx) so they can run under node --test.
// The renderer is JSX/TSX and imports react-dom/server, which plain tsc cannot emit for node.
import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OUT = 'dist/main/renderer-tests';
const SRC = 'src/renderer';
mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter(name => name.endsWith('.test.tsx') || name.endsWith('.test.ts'));
for (const file of files) {
  await build({
    entryPoints: [join(SRC, file)],
    outfile: join(OUT, file.replace(/\.tsx?$/, '.js')),
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/server'],
    logLevel: 'warning',
  });
  console.log('built renderer test:', file);
}
if (!files.length) console.log('no renderer tests found');