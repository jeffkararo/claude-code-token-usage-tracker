const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;

function sourceFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

test('every setting the extension reads is declared in package.json', () => {
	const read = new Set();
	for (const file of sourceFiles(path.join(root, 'src'))) {
		const text = fs.readFileSync(file, 'utf8');
		for (const m of text.matchAll(/(?:config|cfg\(\))\.get(?:<[^>]*>)?\(\s*'([A-Za-z.]+)'/g)) read.add(m[1]);
		for (const m of text.matchAll(/getConfiguration\('claudeTracker'\)\s*\.get(?:<[^>]*>)?\('([A-Za-z.]+)'/g)) read.add(m[1]);
	}
	assert.ok(read.size > 15, `only found ${read.size} settings reads`);
	const missing = [...read].filter(key => !(`claudeTracker.${key}` in props));
	assert.deepEqual(missing, []);
});

test('every declared setting has a default and a description, and is used by the code', () => {
	const source = sourceFiles(path.join(root, 'src'))
		.map(f => fs.readFileSync(f, 'utf8'))
		.join('\n');
	const client = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');
	for (const [key, def] of Object.entries(props)) {
		assert.ok('default' in def, `${key} has no default`);
		assert.ok(def.description || def.markdownDescription, `${key} has no description`);
		const short = key.replace('claudeTracker.', '');
		assert.ok(source.includes(`'${short}'`) || client.includes(short), `${key} is declared but never read`);
	}
});

test('level settings: thresholds and the three colours are configurable', () => {
	assert.equal(props['claudeTracker.warningAtUsedPercent'].default, 75);
	assert.equal(props['claudeTracker.criticalAtUsedPercent'].default, 90);
	assert.equal(props['claudeTracker.quotaDisplay'].default, 'remaining');
	for (const key of ['normalColor', 'warningColor', 'criticalColor']) {
		const def = props[`claudeTracker.${key}`];
		assert.ok(def, `${key} missing`);
		assert.equal(def.type, 'string');
		assert.ok(def.pattern, `${key} has no pattern`);
		assert.ok(new RegExp(def.pattern).test(def.default), `${key} default does not satisfy its own pattern`);
	}
	assert.equal('claudeTracker.belowFullColor' in props, false, 'belowFullColor was replaced by normalColor');
});

test('every contributed command is registered by the extension', () => {
	const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8') + fs.readFileSync(path.join(root, 'src', 'terminal.ts'), 'utf8');
	for (const { command } of pkg.contributes.commands) assert.ok(source.includes(`'${command}'`), `${command} is not registered`);
});

test('source has no unexpanded regex capture tokens such as $1', () => {
	// A replacer-function mistake once produced valid-looking code with keys named "$1effective".
	for (const file of sourceFiles(path.join(root, 'src'))) {
		const text = fs.readFileSync(file, 'utf8');
		const bad = text.split('\n').filter(line => /[{,(]\s*\$[0-9]\w*\s*[:,)]/.test(line));
		assert.deepEqual(bad, [], `${path.basename(file)} contains $N tokens`);
	}
});
