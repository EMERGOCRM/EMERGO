/* Copia los recursos no-TS (schema.sql) a dist/ tras compilar. */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['schema.sql'];

for (const f of files) {
  const from = path.join(root, 'src', f);
  const to = path.join(root, 'dist', f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[copy-assets] ${f} -> dist/${f}`);
}
