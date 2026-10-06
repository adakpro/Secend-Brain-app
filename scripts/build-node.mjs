// Bundles a Node entrypoint (and workspace packages) into one ESM file.
// Native or runtime-resolved modules stay external and are installed in the image.
import { build } from 'esbuild';
const [entry, outfile, ...rest] = process.argv.slice(2);
const extraExternal = rest.filter(a => a.startsWith('--external:')).map(a => a.slice(11));
await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: true, legalComments: 'linked',
  external: ['@node-rs/argon2', 'pg', 'pg-boss', 'pdfjs-dist', 'linkedom', 'node-pty', ...extraExternal],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
