// Copies the Chart.js UMD bundle into media/ so the webview can load it locally.
const fs = require('fs');
const path = require('path');

// The package "exports" map hides dist/ and package.json, so locate the package directory from its main entry.
const main = require.resolve('chart.js');
const source = path.join(main.slice(0, main.lastIndexOf(`${path.sep}dist${path.sep}`)), 'dist', 'chart.umd.min.js');
const target = path.join(__dirname, '..', 'media', 'chart.umd.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied ${path.relative(process.cwd(), source)} -> ${path.relative(process.cwd(), target)}`);
