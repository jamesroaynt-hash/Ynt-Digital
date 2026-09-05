const fs = require('fs');
const src = fs.readFileSync('./_live_app.js', 'utf8'); // the DEPLOYED bundle

const block = src.match(/const renderFns = \{([\s\S]*?)\n  \};/);
if (!block) { console.log('renderFns block not found'); process.exit(1); }

const names = [...block[1].matchAll(/:\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
console.log('renderFns entries:', names.length);

const isDeclared = (n) => new RegExp(
  '(?:function\\s+' + n + '\\s*\\(|(?:const|let|var)\\s+' + n + '\\s*=|window\\.' + n + '\\s*=)'
).test(src);

const missing = names.filter((n) => !isDeclared(n));
console.log(missing.length ? 'MISSING renderFns: ' + missing.join(', ') : 'all renderFns defined');

// initPage is the other half of the render path — same failure mode.
const initBlock = src.match(/function initPage\(page\) \{([\s\S]*?)\n\}/);
if (initBlock) {
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
    'function', 'const', 'let', 'var', 'new', 'await', 'else', 'case', 'break']);
  const called = [...new Set(
    [...initBlock[1].matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]{3,})\s*\(/g)].map((m) => m[1])
  )].filter((n) => !KEYWORDS.has(n));
  const undef = called.filter((n) => !isDeclared(n));
  console.log('initPage calls checked:', called.length,
    '| undefined:', undef.length ? undef.join(', ') : 'none');
}
