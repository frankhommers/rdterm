// Bundle the CLI into one file, dist/rdterm.mjs, that needs only Node.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, chmodSync } from 'node:fs';

const require = createRequire(import.meta.url);
const version = process.env.RDTERM_VERSION || JSON.parse(readFileSync('package.json', 'utf8')).version;

await build({
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/rdterm.mjs',
  alias: { 'libsodium-wrappers': require.resolve('libsodium-wrappers') },
  define: { RDTERM_VERSION: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
});
chmodSync('dist/rdterm.mjs', 0o755);
console.log(`built dist/rdterm.mjs (${version})`);
