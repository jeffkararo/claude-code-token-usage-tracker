#!/usr/bin/env node
// Read-only check of the public Visual Studio Marketplace and Open VSX for names that are already taken.
//
//   npm run check-name -- "Name One" "Name Two"
//   npm run check-name -- --categories "Name One"
//
// Reports, for each candidate: extensions whose display name or ID matches exactly, and ones that contain it.
// With --categories it also reads the manifests of the extensions those searches found and lists command-palette
// categories (the "Category:" prefix) that match a candidate. The Marketplace cannot search by category, so this
// only covers the extensions that turn up, not every extension. It does not check trademarks.
'use strict';

const MARKET = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const args = process.argv.slice(2);
const withCategories = args.includes('--categories');
const candidates = args.filter(a => !a.startsWith('--'));

if (!candidates.length) {
	console.error('Usage: node scripts/check-marketplace-name.cjs [--categories] "Candidate name" ["Another name" ...]');
	process.exit(1);
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function marketSearch(text, pageSize = 50) {
	const body = {
		filters: [{ criteria: [{ filterType: 8, value: 'Microsoft.VisualStudio.Code' }, { filterType: 10, value: text }], pageNumber: 1, pageSize, sortBy: 0, sortOrder: 0 }],
		assetTypes: [],
		flags: 914,
	};
	const res = await fetch(MARKET, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.1-preview.1' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Marketplace returned HTTP ${res.status}`);
	const result = (await res.json()).results[0];
	const count = (result.resultMetadata.find(m => m.metadataType === 'ResultCount')?.metadataItems.find(i => i.name === 'TotalCount') || {}).count ?? 0;
	return {
		total: count,
		items: result.extensions.map(e => ({
			id: `${e.publisher.publisherName}.${e.extensionName}`,
			name: e.extensionName,
			displayName: e.displayName,
			publisher: e.publisher.displayName,
			installs: Math.round((e.statistics || []).find(s => s.statisticName === 'install')?.value ?? 0),
			manifest: ((e.versions[0] || {}).files || []).find(f => f.assetType === 'Microsoft.VisualStudio.Code.Manifest')?.source,
		})),
	};
}

async function openVsxSearch(text) {
	const res = await fetch(`https://open-vsx.org/api/-/search?query=${encodeURIComponent(text)}&size=50`);
	if (!res.ok) throw new Error(`Open VSX returned HTTP ${res.status}`);
	return (await res.json()).extensions.map(e => ({ id: `${e.namespace}.${e.name}`, name: e.name, displayName: e.displayName || e.name }));
}

const isExact = (item, candidate) => {
	const n = norm(candidate);
	return norm(item.displayName) === n || norm(item.name) === n || norm(item.name) === n.replace(/ /g, '-');
};

(async () => {
	const found = new Map();
	console.log('Visual Studio Marketplace');
	for (const candidate of candidates) {
		const { total, items } = await marketSearch(candidate);
		const exact = items.filter(i => isExact(i, candidate));
		const contains = items.filter(i => !exact.includes(i) && norm(i.displayName).includes(norm(candidate)));
		console.log(`\n  "${candidate}"  (${total} loose search hits)  exact: ${exact.length}  contains: ${contains.length}`);
		for (const i of exact) console.log(`    TAKEN     ${i.displayName}  [${i.id}]  by ${i.publisher}, ${i.installs} installs`);
		for (const i of contains.slice(0, 6)) console.log(`    similar   ${i.displayName}  [${i.id}]  by ${i.publisher}, ${i.installs} installs`);
		if (!exact.length) console.log('    no exact match');
		for (const i of items) found.set(i.id, i);
	}

	console.log('\nOpen VSX');
	for (const candidate of candidates) {
		const hits = await openVsxSearch(candidate);
		const exact = hits.filter(h => isExact(h, candidate));
		console.log(`  "${candidate}"  exact: ${exact.length}${exact.length ? '  TAKEN: ' + exact.map(e => e.id).join(', ') : ''}`);
	}

	if (withCategories) {
		console.log(`\nCommand-palette categories (reading ${found.size} manifests; this takes a moment)`);
		const categories = new Map();
		let read = 0;
		for (const ext of found.values()) {
			if (!ext.manifest) continue;
			try {
				const res = await fetch(ext.manifest);
				if (!res.ok) continue;
				const pkg = await res.json();
				read++;
				for (const cmd of (pkg.contributes && pkg.contributes.commands) || []) {
					const category = typeof cmd.category === 'string' ? cmd.category : cmd.category && cmd.category.value;
					if (!category) continue;
					const key = norm(category);
					if (!categories.has(key)) categories.set(key, { name: category, by: new Set() });
					categories.get(key).by.add(ext.id);
				}
			} catch {
				// An unreadable manifest just means that extension is not covered.
			}
		}
		console.log(`  read ${read} manifests`);
		for (const candidate of candidates) {
			const hit = categories.get(norm(candidate));
			console.log(`  category "${candidate}": ${hit ? 'IN USE by ' + [...hit.by].join(', ') : 'not used by any extension found'}`);
		}
	}
})().catch(error => {
	console.error('Check failed:', error.message);
	process.exit(1);
});
