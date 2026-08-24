// Replaces html-inline: strips lines containing "body" (same as the old
// `grep -v body` step) and inlines <script src=...> contents from dist/.
// Usage: node scripts/inline-html.js > out.html   (pipe to html-minifier)
const { readFileSync } = require('fs');
const { join } = require('path');

const DIST = join(__dirname, '..', 'dist');
const html = readFileSync(join(__dirname, '..', 'src', 'index.html'), 'utf8');

const out = html
  .split('\n')
  .filter(line => !line.includes('body'))
  .join('\n')
  .replace(/<script src=["']?([^"'>]+)["']?><\/script>/g, (_, src) =>
    `<script>${readFileSync(join(DIST, src), 'utf8')}</script>`);

process.stdout.write(out);
