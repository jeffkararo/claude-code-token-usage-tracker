// Usage Tracker dashboard (webview client). Plain browser JS, no bundler.
(function () {
	'use strict';
	/* global acquireVsCodeApi, Chart */
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);

	// Well-separated hues for groups that would otherwise sit next to each other (model × effort pairs).
	const CONTRAST = ['#e8684a', '#3794ff', '#f2c14e', '#3fbca8', '#c86dd7', '#7cc36a', '#ff9f43', '#5ac8e0', '#e05d9e', '#b8e986', '#9aa5b8', '#c0392b'];
	const PALETTE = ['#d97757', '#3fbca8', '#a45de3', '#3794ff', '#e8a23a', '#e05d9e', '#7cc36a', '#8b9bb4', '#c9a227', '#5ac8e0'];
	// [key, button label, long label]
	const RANGES = [
		['1d', 'Today', 'Today'],
		['24h', '1D', 'Last 24 hours'],
		['7d', '7D', 'Last 7 days'],
		['14d', '2W', 'Last 2 weeks'],
		['21d', '3W', 'Last 3 weeks'],
		['30d', '30D', 'Last 30 days'],
		['90d', '90D', 'Last 90 days'],
		['365d', '1Y', 'Last year'],
		['all', 'All', 'All time'],
	];
	const EFFORT_COLORS = { low: '#3fbca8', medium: '#3794ff', high: '#a45de3', xhigh: '#d97757', max: '#e5484d', 'not set': '#8b9bb4' };
	const BREAKDOWN_METRICS = [
		['total', 'All tokens'],
		['fresh', 'Fresh input'],
		['output', 'Output'],
		['thinking', 'Thinking'],
	];
	const ROW_CHOICES = [25, 50, 100, 250, 0];

	let state = null;
	let built = false;
	let layout = { order: [], sizes: {}, hidden: [] };
	const charts = new Map();
	const ui = Object.assign(
		{
			promptSort: { key: 'ts', dir: -1 },
			sessionSort: { key: 'end', dir: -1 },
			promptQuery: '',
			sessionQuery: '',
			promptRows: 50,
			bannerDismissed: false,
			breakdownDims: ['model'],
			breakdownMetric: 'total',
		},
		vscode.getState() || {},
	);
	// 0.3 stored a single dimension; keep the viewer's choice.
	if (!Array.isArray(ui.breakdownDims)) ui.breakdownDims = [ui.breakdownDim === 'effort' ? 'effort' : 'model'];
	delete ui.breakdownDim;
	const breakdownKey = () => (ui.breakdownDims.length === 2 ? 'modelEffort' : ui.breakdownDims[0]);
	const saveUi = () => vscode.setState(ui);
	const post = message => vscode.postMessage(message);

	// ---------- formatting ----------
	const esc = value =>
		String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	function usd(v, precise) {
		if (!Number.isFinite(v)) return '$0.00';
		if (precise || Math.abs(v) < 10) return '$' + v.toFixed(2);
		if (Math.abs(v) < 1000) return '$' + v.toFixed(1);
		return '$' + Math.round(v).toLocaleString('en-US');
	}
	function tok(v) {
		if (!Number.isFinite(v) || v === 0) return '0';
		const a = Math.abs(v);
		if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
		if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
		if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
		return String(Math.round(v));
	}
	const tickUsd = v => '$' + (Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v === 0 ? 0 : Math.abs(v) < 1 ? 2 : 1));
	const pct = (v, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v * 100).toFixed(digits) + '%');
	function dur(ms) {
		if (!Number.isFinite(ms)) return '—';
		const m = Math.max(0, Math.round(ms / 60000));
		if (m < 60) return m + 'm';
		const h = Math.floor(m / 60);
		if (h < 48) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
		return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
	}
	function clock(ts) {
		const d = new Date(ts);
		const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		return new Date().toDateString() === d.toDateString() ? t : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + t;
	}
	function ago(ts) {
		const s = Math.round((Date.now() - ts) / 1000);
		if (s < 60) return 'just now';
		if (s < 3600) return Math.round(s / 60) + 'm ago';
		if (s < 86400) return Math.round(s / 3600) + 'h ago';
		return Math.round(s / 86400) + 'd ago';
	}
	function stamp(ts) {
		const d = new Date(ts);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	function delta(current, previous) {
		if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return { text: '', cls: '' };
		const change = (current - previous) / previous;
		if (!Number.isFinite(change)) return { text: '', cls: '' };
		const arrow = change >= 0 ? '▲' : '▼';
		return { text: `${arrow} ${Math.abs(change * 100).toFixed(0)}% vs prev`, cls: change >= 0 ? 'up' : 'down' };
	}
	const baseName = p => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || '';

	function cssColor(name, fallback) {
		const probe = document.createElement('span');
		probe.style.color = `var(${name})`;
		probe.style.display = 'none';
		document.body.appendChild(probe);
		const value = getComputedStyle(probe).color;
		probe.remove();
		return value && value.startsWith('rgb') ? value : fallback;
	}
	function hexToRgb(hex) {
		const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
		if (!m) return [217, 119, 87];
		const n = parseInt(m[1], 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}

	// ---------- quota helpers ----------
	/** Pushes the validated colours into CSS variables. An empty normal colour falls back to the accent. */
	function applyColours(s) {
		const rootStyle = document.documentElement.style;
		const e = s.effective;
		rootStyle.setProperty('--c-warning', e.warningColor);
		rootStyle.setProperty('--c-critical', e.criticalColor);
		if (e.normalColor) {
			rootStyle.setProperty('--c-normal', e.normalColor);
			rootStyle.setProperty('--c-normal-text', e.normalColor);
		} else {
			rootStyle.setProperty('--c-normal', 'var(--accent)');
			rootStyle.removeProperty('--c-normal-text');
		}
	}
	function levelOf(used, s) {
		// Thresholds are percentages used (default warning 75%, critical 90%).
		if (used >= s.effective.critical) return 'critical';
		if (used >= s.effective.warning) return 'warning';
		return 'ok';
	}
	const usedMode = () => Boolean(state && state.settings && state.settings.quotaDisplay === 'used');
	function shown(w, s) {
		if (w.usedPercent === null) return null;
		return s.quotaDisplay === 'used' ? w.usedPercent : 100 - w.usedPercent;
	}
	const shortLabel = w => (w.key === 'fiveHour' ? '5H' : w.key === 'sevenDay' ? 'Weekly' : 'Spend');

	/** Tooltip text for the purple time marker: the time left in the window, plus the elapsed point when showing used. */
	function timeTip(w, s) {
		if (!w.resetsAt || w.windowStart === null || w.elapsedFraction === null) return '';
		const now = Date.now();
		const span = w.resetsAt - w.windowStart;
		const remaining = Math.max(0, w.resetsAt - now);
		const left = Math.round((remaining / span) * 100);
		let text = `Time remaining in this window: ${dur(remaining)} of ${dur(span)} (${left}%).`;
		if (s.quotaDisplay === 'used') text += ` The marker is at the elapsed point (${100 - left}% of the window).`;
		return text;
	}
	/** Legend under a "Resets" line: says what the marker line means in the current display mode. Never names its colour, which is configurable. */
	function legendHtml(s) {
		const meaning = s.quotaDisplay === 'used' ? 'Marker line = time elapsed in this window' : 'Marker line = time remaining in this window';
		return `<span class="legend"><i class="key"></i>${meaning}</span>`;
	}

	function paceText(w) {
		const now = Date.now();
		if (w.usedPercent === null) return { text: w.windowStart !== null ? `Local ${usd(w.localCost)} this window` : '', cls: '' };
		if (w.projectedFullAt) return { text: `Runs out ~${clock(w.projectedFullAt)}`, cls: 'pace-bad' };
		if (w.pctPerHour !== null && w.resetsAt) {
			const left = Math.max(0, 100 - w.usedPercent - w.pctPerHour * ((w.resetsAt - now) / 3600000));
			return { text: `${w.pctPerHour.toFixed(1)}%/h · ~${usedMode() ? Math.round(100 - left) + '% used' : Math.round(left) + '% left'} at reset`, cls: 'pace-good' };
		}
		if (w.elapsedFraction !== null && w.usedPercent / 100 > w.elapsedFraction + 0.1) return { text: 'Ahead of an even pace', cls: 'pace-bad' };
		return { text: w.costPerHour !== null ? `${usd(w.costPerHour)}/h local` : '', cls: '' };
	}

	// ---------- top bar ----------
	function renderRanges(model) {
		$('ranges').innerHTML = RANGES.map(
			([key, label]) => `<button class="range${model.range === key ? ' active' : ''}" type="button" data-range="${key}">${label}</button>`,
		).join('');
	}

	function renderQuotaStrip(model, s) {
		const windows = model.windows.filter(w => w.usedPercent !== null);
		if (!windows.length) {
			$('quotaStrip').innerHTML =
				`<span class="quota-pill">Today <strong>${usd(model.today.cost)}</strong><small>${tok(model.today.tokens)} tokens</small></span>` +
				`<span class="quota-pill">Month <strong>${usd(model.month.cost)}</strong></span>`;
			return;
		}
		const pill = w => {
			const value = shown(w, s);
			const level = levelOf(w.usedPercent, s);
			const title = [w.resetsAt ? `Resets in ${dur(w.resetsAt - Date.now())} (${clock(w.resetsAt)})` : '', w.stale ? 'Last reported ' + ago(model.bridge.lastAt || 0) : '']
				.filter(Boolean)
				.join(' · ');
			return `<span class="quota-pill ${level}${w.stale ? ' stale' : ''}" title="${esc(title)}">${shortLabel(w)} <strong>${Math.round(value)}%</strong><small>${w.resetsAt ? '↻ ' + dur(w.resetsAt - Date.now()) : ''}</small></span>`;
		};
		const bars = windows
			.filter(w => w.key !== 'spend')
			.map(w => {
				const remaining = s.quotaDisplay === 'used' ? w.usedPercent : 100 - w.usedPercent;
				const time = w.elapsedFraction === null ? 0 : (s.quotaDisplay === 'used' ? w.elapsedFraction : 1 - w.elapsedFraction) * 100;
				const label = w.key === 'fiveHour' ? '5H' : 'W';
				return (
					`<span class="mini-bar" title="${label}: ${Math.round(remaining)}% ${s.quotaDisplay === 'used' ? 'used' : 'left'}"><i style="height:${Math.max(2, remaining * 0.36)}px"></i><span>${label}</span></span>` +
					`<span class="mini-bar time" title="${label}: ${Math.round(time)}% of window time ${s.quotaDisplay === 'used' ? 'elapsed' : 'left'}"><i style="height:${Math.max(2, time * 0.36)}px"></i><span>T</span></span>`
				);
			})
			.join('');
		const [first, ...rest] = windows;
		$('quotaStrip').innerHTML = pill(first) + `<span class="mini-bars">${bars}</span>` + rest.map(pill).join('');
	}

	function renderMeters(model, s) {
		const word = s.quotaDisplay === 'used' ? 'Used' : 'Remaining';
		$('meters').innerHTML = model.windows
			.map(w => {
				const value = shown(w, s);
				const level = w.usedPercent === null ? '' : levelOf(w.usedPercent, s);
				const fill = value === null ? 0 : Math.min(100, Math.max(0, value));
				let marker = '';
				if (w.elapsedFraction !== null) {
					const pos = (s.quotaDisplay === 'used' ? w.elapsedFraction : 1 - w.elapsedFraction) * 100;
					marker = `<b style="left:calc(${pos.toFixed(1)}% - 1px)" data-tip="${esc(timeTip(w, s))}"></b>`;
				}
				const pace = paceText(w);
				const extra = w.key === 'spend' && w.usedUsd !== undefined ? ` · ${usd(w.usedUsd)} / ${usd(w.limitUsd || 0)}` : '';
				return `<article class="meter-panel ${level}">
					<div class="meter-head"><strong>${w.label} ${word}</strong><span class="value ${level}">${value === null ? 'N/A' : Math.round(value) + '%'}${w.stale ? ' ~' : ''}${extra}</span></div>
					<div class="meter" role="progressbar" aria-label="${esc(w.label)} ${word}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fill)}"><i style="width:${fill}%"></i>${marker}</div>
					<div class="meter-foot"><span>${w.resetsAt ? 'Resets in ' + dur(w.resetsAt - Date.now()) + ' · ' + clock(w.resetsAt) + '<br>' + legendHtml(s) : w.usedPercent === null ? 'Connect the bridge for live limits' : ''}</span><span class="${pace.cls}">${esc(pace.text)}</span></div>
				</article>`;
			})
			.join('');
	}

	function renderBanner(model) {
		const banner = $('bridgeBanner');
		const b = model.bridge;
		if (!b.connected && !ui.bannerDismissed) {
			banner.innerHTML = `<span class="status-dot"></span><p><strong>Live 5-hour and weekly limits</strong> come from Claude Code's statusline. Connect the bridge to see them here; tokens, costs, projects and tools already work from your local transcripts.</p>
				<div class="actions"><button class="btn primary" data-action="connectBridge" type="button">Connect bridge</button><button class="btn" data-action="dismissBanner" type="button">Later</button></div>`;
			banner.hidden = false;
		} else if (b.connected && !b.receiving) {
			banner.innerHTML = `<span class="status-dot wait"></span><p><strong>Bridge connected</strong> — waiting for limits. Claude Code only reports them from a terminal session; the VS Code chat panel does not run the statusline. Send one prompt in a Claude Code terminal (Pro and Max plans) and they will appear here.</p>
				<div class="actions"><button class="btn primary" data-action="openClaudeTerminal" type="button">Open Claude Code terminal</button></div>`;
			banner.hidden = false;
		} else {
			banner.hidden = true;
		}
	}

	// ---------- charts ----------
	function themeColors() {
		return { text: cssColor('--muted', 'rgb(165,165,165)'), grid: 'rgba(128,128,128,0.16)', accent: PALETTE[0] };
	}
	function axisOptions(colors, extra) {
		return Object.assign(
			{
				ticks: { color: colors.text, maxRotation: 0, autoSkip: true, autoSkipPadding: 12, font: { size: 10 } },
				grid: { color: colors.grid, drawTicks: false },
				border: { display: false },
			},
			extra || {},
		);
	}
	function upsertChart(id, canvas, config) {
		const existing = charts.get(id);
		if (existing && existing.canvas === canvas) {
			existing.data.labels = config.data.labels;
			config.data.datasets.forEach((ds, i) => {
				if (existing.data.datasets[i]) Object.assign(existing.data.datasets[i], { data: ds.data, label: ds.label, backgroundColor: ds.backgroundColor });
				else existing.data.datasets.push(ds);
			});
			existing.data.datasets.length = config.data.datasets.length;
			existing.update('none');
			return existing;
		}
		if (existing) existing.destroy();
		const chart = new Chart(canvas, config);
		charts.set(id, chart);
		return chart;
	}
	function sparkline(id, canvas, values, color) {
		upsertChart(id, canvas, {
			type: 'line',
			data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, backgroundColor: color + '33', fill: true, tension: 0.35, pointRadius: 0, borderWidth: 1.6 }] },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: { legend: { display: false }, tooltip: { enabled: false } },
				scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
			},
		});
	}

	// ---------- cards ----------
	const METRICS = [
		{ id: 'metric-prompts', label: 'Prompts', value: t => t.prompts.toLocaleString(), series: p => p.prompts, raw: t => t.prompts, get color() { return PALETTE[0]; } },
		{ id: 'metric-output', label: 'Output Tokens', value: t => tok(t.output), series: p => p.output, raw: t => t.output, get color() { return PALETTE[2]; } },
		{ id: 'metric-input', label: 'Fresh Input', info: 'Uncached input plus cache writes.', value: t => tok(t.input + t.cacheWrite), series: p => p.input + p.cacheWrite, raw: t => t.input + t.cacheWrite, get color() { return PALETTE[3]; } },
		{ id: 'metric-cache', label: 'Cache Hit Rate', info: 'Cache reads as a share of all input tokens.', value: t => pct(t.cacheHitRate, 1), series: p => (p.cacheHitRate ?? 0) * 100, raw: t => t.cacheHitRate, get color() { return PALETTE[1]; } },
		{ id: 'metric-savings', label: 'Cache Savings', info: 'What cache reads would have cost as fresh input, minus what they did cost.', value: t => usd(t.cacheSavings), series: p => p.cacheRead, raw: t => t.cacheSavings, get color() { return PALETTE[6]; } },
		{ id: 'metric-calls', label: 'API Calls', value: t => t.calls.toLocaleString(), series: p => p.calls, raw: t => t.calls, get color() { return PALETTE[4]; } },
	];

	const CARDS = [
		{ id: 'spend', title: 'API-Equivalent Spend', span: 8, minSpan: 4, info: 'Estimated at Anthropic list prices from the token counts in your transcripts. Subscription plans are not billed per token; this shows what the same usage would cost on the API.' },
		{ id: 'live', title: 'Live Sessions', span: 4, minSpan: 3, info: 'Claude Code sessions running now. Context and cache details come from the statusline bridge.' },
		...METRICS.map(m => ({ id: m.id, title: m.label, span: 2, minSpan: 2, metric: m })),
		{ id: 'tokens', title: 'Tokens', span: 8, minSpan: 4, info: 'Click legend entries to hide a series. Cache reads usually dominate.' },
		{ id: 'breakdown', title: 'Tokens by Model & Reasoning', span: 12, minSpan: 6, info: 'Splits token usage by model, by the reasoning effort each turn ran at (low to max), or by both: select one or both buttons. Thinking tokens are the reasoning part of output tokens. Click legend entries to hide a group.' },
		{ id: 'models', title: 'Models', span: 4, minSpan: 3 },
		{ id: 'windows', title: 'Limit Windows & Pace', span: 6, minSpan: 4, info: 'Pace is projected from how fast the bridge-reported percentage has moved recently. The marker on each bar shows how much of the window’s time is left.' },
		{ id: 'heatmap', title: 'When You Work', span: 6, minSpan: 4, info: 'API-equivalent spend by weekday and hour of day (local time).' },
		{ id: 'projects', title: 'Projects', span: 6, minSpan: 3 },
		{ id: 'tools', title: 'Tool Calls', span: 6, minSpan: 3 },
		{ id: 'prompts', title: 'Prompt Usage', span: 12, minSpan: 6, table: true },
		{ id: 'sessions', title: 'Sessions', span: 12, minSpan: 6, table: true },
	];
	const cardById = new Map(CARDS.map(c => [c.id, c]));

	function cardShell(card) {
		const info = card.info ? `<button class="info" type="button" data-tip="${esc(card.info)}" aria-label="About ${esc(card.title)}">i</button>` : '';
		if (card.metric) {
			return `<article class="card metric" data-card="${card.id}"><div class="card-head label"><span>${esc(card.title)}</span>${info}</div><div class="value num" data-slot="value">—</div><div class="delta" data-slot="delta"></div><div class="chart-wrap"><canvas data-slot="chart"></canvas></div></article>`;
		}
		let head = `<span class="grip" aria-hidden="true">⋮⋮</span><h2>${esc(card.title)}</h2>${info}<span class="spacer"></span>`;
		let body = '<div data-slot="body"></div>';
		if (card.id === 'prompts') {
			head += `<input class="search" data-slot="search" type="search" placeholder="Search prompts, projects, models" value="${esc(ui.promptQuery)}">
				<label class="muted">Rows <select data-slot="rows">${ROW_CHOICES.map(n => `<option value="${n}"${n === ui.promptRows ? ' selected' : ''}>${n || 'All'}</option>`).join('')}</select></label>
				<button class="btn small" type="button" data-action="export" data-format="csv">CSV</button><button class="btn small" type="button" data-action="export" data-format="json">JSON</button>`;
			body = '<div class="table-scroll"><table><thead data-slot="thead"></thead><tbody data-slot="tbody"></tbody></table></div><div class="table-foot" data-slot="foot"></div>';
		} else if (card.id === 'sessions') {
			head += `<input class="search" data-slot="search" type="search" placeholder="Search sessions" value="${esc(ui.sessionQuery)}">`;
			body = '<div class="table-scroll"><table><thead data-slot="thead"></thead><tbody data-slot="tbody"></tbody></table></div><div class="table-foot" data-slot="foot"></div>';
		} else if (card.id === 'spend') {
			body = `<div class="spend"><div data-slot="summary"></div><div class="chart-wrap"><canvas data-slot="chart"></canvas></div></div>`;
		} else if (card.id === 'tokens') {
			body = '<div class="chart-wrap" style="height:250px"><canvas data-slot="chart"></canvas></div>';
		} else if (card.id === 'breakdown') {
			const dims = [
				['model', 'Model'],
				['effort', 'Reasoning Effort'],
			];
			head += `<span class="seg" role="group" aria-label="Group by (select one or both)" title="Select one or both">${dims
				.map(([k, l]) => `<button type="button" class="seg-btn${ui.breakdownDims.includes(k) ? ' active' : ''}" data-dim="${k}" aria-pressed="${ui.breakdownDims.includes(k)}">${l}</button>`)
				.join('')}</span>
				<label class="muted">Show <select data-slot="metric">${BREAKDOWN_METRICS.map(([k, l]) => `<option value="${k}"${ui.breakdownMetric === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
			body =
				'<div class="breakdown"><div class="chart-wrap" style="height:260px"><canvas data-slot="chart"></canvas></div><div class="table-scroll breakdown-table"><table><thead data-slot="thead"></thead><tbody data-slot="tbody"></tbody></table></div></div>';
		} else if (card.id === 'models') {
			body = '<div class="chart-wrap" style="height:170px"><canvas data-slot="chart"></canvas></div><div class="legend-list" data-slot="body"></div>';
		} else if (card.id === 'tools') {
			body = '<div class="chart-wrap" style="height:260px"><canvas data-slot="chart"></canvas></div>';
		}
		return `<article class="card${card.table ? ' table-card' : ''}" data-card="${card.id}"><div class="card-head">${head}</div>${body}</article>`;
	}

	function slot(cardId, name) {
		return document.querySelector(`[data-card="${cardId}"] [data-slot="${name}"]`);
	}

	function updateSpend(model) {
		const t = model.totals;
		const d = delta(t.cost, model.previous && model.previous.cost);
		const rangeLabel = (RANGES.find(r => r[0] === model.range) || [])[2] || '';
		const perPrompt = t.prompts ? t.cost / t.prompts : 0;
		const plan = model.planValue
			? `<div class="plan-value">Your ${usd(model.planValue.monthlyPrice)}/mo plan delivered <strong>${usd(model.planValue.monthCost)}</strong> of API-equivalent usage this month — <strong>${model.planValue.multiple.toFixed(model.planValue.multiple < 1 ? 2 : 1)}×</strong></div>`
			: '';
		slot('spend', 'summary').innerHTML = `
			<div class="sub-value">${esc(rangeLabel)}</div>
			<div class="big-value">${usd(t.cost)}</div>
			<div class="trend ${d.cls}">${d.text || '&nbsp;'}</div>
			<div class="stat-list">
				<div>Today<b>${usd(model.today.cost)}</b></div>
				<div>This month<b>${usd(model.month.cost)}</b></div>
				<div>Per prompt<b>${usd(perPrompt, true)}</b></div>
				<div>Subagents<b>${t.cost ? pct(t.subagentCost / t.cost) : '—'}</b></div>
				<div>Web searches<b>${t.webSearches.toLocaleString()}</b></div>
				${t.unpricedCalls ? `<div title="Models without a known price are counted as $0">Unpriced calls<b>${t.unpricedCalls}</b></div>` : ''}
			</div>${plan}`;
		const colors = themeColors();
		upsertChart('spend', slot('spend', 'chart'), {
			data: {
				labels: model.series.map(p => p.label),
				datasets: [
					{ type: 'bar', label: 'Cost', data: model.series.map(p => +p.cost.toFixed(4)), backgroundColor: PALETTE[0], borderRadius: 3, yAxisID: 'y', order: 2 },
					{ type: 'line', label: 'Prompts', data: model.series.map(p => p.prompts), borderColor: PALETTE[2], backgroundColor: PALETTE[2], pointRadius: 0, tension: 0.35, borderWidth: 1.8, yAxisID: 'y1', order: 1 },
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: { display: true, position: 'top', align: 'end', labels: { color: colors.text, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
					tooltip: { callbacks: { label: ctx => (ctx.dataset.label === 'Cost' ? ' Cost ' + usd(ctx.parsed.y, true) : ' Prompts ' + ctx.parsed.y) } },
				},
				scales: {
					x: axisOptions(colors, { grid: { display: false } }),
					y: axisOptions(colors, { beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: tickUsd } }),
					y1: axisOptions(colors, { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: colors.text, font: { size: 10 }, precision: 0 } }),
				},
			},
		});
	}

	function updateMetric(card, model) {
		const m = card.metric;
		const t = model.totals;
		slot(card.id, 'value').textContent = m.value(t);
		const prev = model.previous ? m.raw(model.previous) : null;
		const d = m.id === 'metric-cache' ? { text: prev !== null && t.cacheHitRate !== null ? `${((t.cacheHitRate - prev) * 100).toFixed(1)} pts vs prev` : '', cls: '' } : delta(m.raw(t), prev);
		const el = slot(card.id, 'delta');
		el.textContent = d.text;
		el.className = 'delta ' + (m.id === 'metric-savings' || m.id === 'metric-cache' ? '' : d.cls);
		sparkline(card.id, slot(card.id, 'chart'), model.series.map(m.series), m.color);
	}

	function updateLive(model) {
		const body = slot('live', 'body');
		if (!model.live.length) {
			body.innerHTML = `<div class="empty">No Claude Code sessions running.${model.bridge.connected ? '' : '<br>Connect the bridge to see context and cache details.'}</div>`;
			return;
		}
		body.innerHTML = `<div class="live-list">${model.live
			.slice(0, 6)
			.map(s => {
				const name = s.name || baseName(s.cwd) || s.sessionId.slice(0, 8);
				const busy = s.status === 'busy';
				const chips = [];
				if (s.model) chips.push(`<span class="chip hot">${esc(s.model)}</span>`);
				if (s.effort) chips.push(`<span class="chip">effort ${esc(s.effort)}</span>`);
				if (s.fastMode) chips.push('<span class="chip hot">fast</span>');
				if (s.sessionCostUsd !== undefined) chips.push(`<span class="chip">${usd(s.sessionCostUsd)} session</span>`);
				if (s.cacheWarm !== undefined) {
					const left = s.cacheExpiresAt ? s.cacheExpiresAt - Date.now() : 0;
					chips.push(
						s.cacheWarm && left > 0
							? `<span class="chip good" title="Prompt cache TTL ${esc(s.cacheTtl || '')}">cache warm · ${dur(left)}</span>`
							: '<span class="chip">cache cold</span>',
					);
				}
				if (s.cacheHitRatio !== undefined) chips.push(`<span class="chip">hit ${pct(s.cacheHitRatio)}</span>`);
				if (s.linesAdded || s.linesRemoved) chips.push(`<span class="chip">+${s.linesAdded || 0} −${s.linesRemoved || 0}</span>`);
				const ctx =
					s.contextPercent !== undefined
						? `<div class="ctx"><div class="row muted"><span>Context</span><span class="num">${Math.round(s.contextPercent)}% · ${tok(s.contextTokens || 0)} / ${tok(s.contextSize || 0)}</span></div><div class="meter"><i style="width:${Math.min(100, s.contextPercent)}%;background-position:${-Math.min(100, s.contextPercent) * 2}px 0"></i></div></div>`
						: '';
				return `<div class="live-item" title="${esc(s.cwd || '')}">
					<div class="row"><span class="name"><span class="status-dot ${busy ? 'busy' : 'on'}"></span>${esc(name)}</span><span class="muted">${busy ? 'working' : esc(s.status || 'open')}</span></div>
					${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}${ctx}</div>`;
			})
			.join('')}</div>`;
	}

	function updateTokens(model) {
		const colors = themeColors();
		const series = model.series;
		upsertChart('tokens', slot('tokens', 'chart'), {
			type: 'bar',
			data: {
				labels: series.map(p => p.label),
				datasets: [
					{ label: 'Input', data: series.map(p => p.input), backgroundColor: PALETTE[3] },
					{ label: 'Output', data: series.map(p => p.output), backgroundColor: PALETTE[2] },
					{ label: 'Cache write', data: series.map(p => p.cacheWrite), backgroundColor: PALETTE[4] },
					{ label: 'Cache read', data: series.map(p => p.cacheRead), backgroundColor: PALETTE[1] },
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: { position: 'top', align: 'end', labels: { color: colors.text, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
					tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label} ${tok(ctx.parsed.y)}` } },
				},
				scales: {
					x: axisOptions(colors, { stacked: true, grid: { display: false } }),
					y: axisOptions(colors, { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: v => tok(v) } }),
				},
			},
		});
	}

	function groupColor(dim, name, i) {
		if (name === 'Other') return '#8b9bb4';
		if (dim === 'effort') return EFFORT_COLORS[name] || PALETTE[(i + 5) % PALETTE.length];
		// Each model × effort pair gets its own clearly different colour; shades of one hue were too hard to tell apart.
		if (dim === 'modelEffort') return CONTRAST[i % CONTRAST.length];
		return PALETTE[i % PALETTE.length];
	}

	function updateBreakdown(model) {
		const dim = breakdownKey();
		const metric = ui.breakdownMetric;
		const groups = model.breakdown[dim];
		const metricLabel = (BREAKDOWN_METRICS.find(m => m[0] === metric) || [])[1];
		const colors = themeColors();
		// Group names change with the dimension, so rebuild the chart rather than patching datasets in place.
		const key = 'breakdown:' + dim;
		const previous = charts.get('breakdown');
		if (previous && previous.$key !== key) {
			previous.destroy();
			charts.delete('breakdown');
		}
		const chart = upsertChart('breakdown', slot('breakdown', 'chart'), {
			type: 'bar',
			data: {
				labels: model.series.map(p => p.label),
				datasets: groups.map((g, i) => ({ label: g.name, data: g.series[metric], backgroundColor: groupColor(dim, g.name, i), stack: 'tokens' })),
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: { position: 'top', align: 'end', labels: { color: colors.text, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
					tooltip: {
						filter: item => item.parsed.y > 0,
						callbacks: { title: items => (items[0] ? items[0].label + ' · ' + metricLabel : ''), label: ctx => ` ${ctx.dataset.label} ${tok(ctx.parsed.y)}` },
					},
				},
				scales: {
					x: axisOptions(colors, { stacked: true, grid: { display: false } }),
					y: axisOptions(colors, { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: v => tok(v) } }),
				},
			},
		});
		chart.$key = key;

		const columns = [
			['name', dim === 'model' ? 'Model' : dim === 'effort' ? 'Effort' : 'Model · Effort'],
			['calls', 'Calls', 1],
			['total', 'All tokens', 1],
			['fresh', 'Fresh input', 1],
			['cacheRead', 'Cache read', 1],
			['output', 'Output', 1],
			['thinking', 'Thinking', 1],
			['thinkShare', 'Thinking %', 1],
			['cost', 'Cost', 1],
		];
		slot('breakdown', 'thead').innerHTML = `<tr>${columns.map(([k, l, r]) => `<th class="${r ? 'r' : ''}${k === metric ? ' sorted' : ''}">${l}</th>`).join('')}</tr>`;
		const sum = groups.reduce((a, g) => a + g[metric], 0);
		slot('breakdown', 'tbody').innerHTML = groups.length
			? groups
					.map((g, i) => {
						const color = groupColor(dim, g.name, i);
						return `<tr class="static"><td><span class="swatch inline" style="background:${color}"></span>${esc(g.name)}<div class="share"><i style="width:${sum ? (g[metric] / sum) * 100 : 0}%;background:${color}"></i></div></td>
					<td class="r">${g.calls.toLocaleString()}</td><td class="r">${tok(g.total)}</td><td class="r">${tok(g.fresh)}</td><td class="r">${tok(g.cacheRead)}</td>
					<td class="r">${tok(g.output)}</td><td class="r">${tok(g.thinking)}</td><td class="r">${g.output ? pct(g.thinking / g.output) : '—'}</td><td class="r">${usd(g.cost)}</td></tr>`;
					})
					.join('')
			: `<tr><td colspan="${columns.length}" class="empty">No usage in this range.</td></tr>`;
	}

	function updateModels(model) {
		const rows = model.models.slice(0, 8);
		const colors = themeColors();
		const useCost = model.totals.cost > 0;
		upsertChart('models', slot('models', 'chart'), {
			type: 'doughnut',
			data: {
				labels: rows.map(r => r.model),
				datasets: [{ data: rows.map(r => (useCost ? r.cost : r.tokens)), backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0 }],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				cutout: '68%',
				plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.label} ${useCost ? usd(ctx.parsed) : tok(ctx.parsed)}` } } },
			},
		});
		void colors;
		slot('models', 'body').innerHTML = rows.length
			? rows
					.map(
						(r, i) =>
							`<div class="legend-row"><span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span><span title="${r.calls} calls · ${tok(r.tokens)} tokens">${esc(r.model)}${r.priced ? '' : ' <span class="muted">(unpriced)</span>'}</span><span class="num">${usd(r.cost)}</span><span class="pct">${pct(r.share)}</span></div>`,
					)
					.join('')
			: '<div class="empty">No usage in this range.</div>';
	}

	function updateWindows(model, s) {
		const now = Date.now();
		slot('windows', 'body').innerHTML = `<div class="window-grid">${model.windows
			.map(w => {
				const value = shown(w, s);
				const level = w.usedPercent === null ? '' : levelOf(w.usedPercent, s);
				let pace = 'Not enough bridge history yet for a pace estimate.';
				let paceCls = 'muted';
				if (w.usedPercent === null) {
					pace = w.windowStart !== null ? 'No live limit data. Showing local usage for this window.' : 'No active window.';
				} else if (w.projectedFullAt) {
					pace = `At this pace the limit is reached ~${clock(w.projectedFullAt)} (in ${dur(w.projectedFullAt - now)}), before it resets.`;
					paceCls = 'meter-foot pace-bad';
				} else if (w.pctPerHour !== null && w.resetsAt) {
					const left = Math.max(0, 100 - w.usedPercent - w.pctPerHour * ((w.resetsAt - now) / 3600000));
					pace = w.pctPerHour === 0 ? 'Flat over the last stretch — plenty of headroom.' : `Burning ${w.pctPerHour.toFixed(1)}%/h — about ${usedMode() ? Math.round(100 - left) + '% should be used' : Math.round(left) + '% should be left'} at reset.`;
					paceCls = 'meter-foot pace-good';
				}
				const fill = value === null ? 0 : Math.min(100, Math.max(0, value));
				const marker =
					w.elapsedFraction !== null ? `<b style="left:calc(${((s.quotaDisplay === 'used' ? w.elapsedFraction : 1 - w.elapsedFraction) * 100).toFixed(1)}% - 1px)" data-tip="${esc(timeTip(w, s))}"></b>` : '';
				return `<div class="window-item ${level}">
					<div class="row"><strong>${esc(w.label)}</strong><span class="pct-big ${level}">${value === null ? 'N/A' : Math.round(value) + '%'} <span class="muted" style="font-size:12px">${s.quotaDisplay === 'used' ? 'used' : 'left'}</span></span></div>
					<div class="meter"><i style="width:${fill}%"></i>${marker}</div>
					<div class="facts">
						<div><span>Resets</span>${w.resetsAt ? esc(clock(w.resetsAt)) + ' · ' + dur(w.resetsAt - now) + '<br>' + legendHtml(s) : '—'}</div>
						<div><span>Window spend</span>${usd(w.localCost)}</div>
						<div><span>Rate</span>${w.costPerHour !== null ? usd(w.costPerHour) + '/h' : '—'}</div>
						<div><span>Tokens</span>${tok(w.localTokens)}</div>
						<div><span>Prompts</span>${w.localPrompts}</div>
						${w.usedUsd !== undefined ? `<div><span>Gateway spend</span>${usd(w.usedUsd)} / ${usd(w.limitUsd || 0)} ${esc(w.period || '')}</div>` : ''}
					</div>
					<div class="${paceCls}" style="margin-top:6px;font-size:12px">${esc(pace)}</div>
				</div>`;
			})
			.join('')}</div>`;
	}

	function updateHeatmap(model) {
		const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
		const [r, g, b] = hexToRgb(PALETTE[0]);
		const max = model.heatmapMax || 0;
		let html = '<div class="heatmap"><span></span>';
		for (let h = 0; h < 24; h++) html += `<span class="hour">${h % 3 === 0 ? h : ''}</span>`;
		model.heatmap.forEach((row, d) => {
			html += `<span>${days[d]}</span>`;
			row.forEach((v, h) => {
				const alpha = max > 0 && v > 0 ? 0.15 + 0.85 * Math.sqrt(v / max) : 0;
				const style = alpha ? ` style="background:rgba(${r},${g},${b},${alpha.toFixed(3)})"` : '';
				html += `<span class="cell"${style} data-tip="${days[d]} ${String(h).padStart(2, '0')}:00 · ${usd(v)}"></span>`;
			});
		});
		html += `</div><div class="heat-legend">less ${[0.15, 0.4, 0.65, 1].map(a => `<i style="background:rgba(${r},${g},${b},${a})"></i>`).join('')} more</div>`;
		slot('heatmap', 'body').innerHTML = html;
	}

	function updateProjects(model) {
		const rows = model.projects.slice(0, 10);
		const max = Math.max(0, ...rows.map(r => r.cost));
		slot('projects', 'body').innerHTML = rows.length
			? `<div class="bar-list">${rows
					.map(
						p =>
							`<div class="bar-row" title="${esc(p.project)}"><div class="top"><span>${esc(p.name)}</span><span class="num">${usd(p.cost)}</span></div><div class="track"><i style="width:${max ? (p.cost / max) * 100 : 0}%"></i></div><div class="meta">${p.sessions} sessions · ${p.prompts} prompts · ${tok(p.tokens)} tokens · ${ago(p.lastActive)}</div></div>`,
					)
					.join('')}</div>`
			: '<div class="empty">No projects in this range.</div>';
	}

	function updateTools(model) {
		const rows = model.tools.slice(0, 12);
		const colors = themeColors();
		upsertChart('tools', slot('tools', 'chart'), {
			type: 'bar',
			data: { labels: rows.map(r => r.name), datasets: [{ label: 'Calls', data: rows.map(r => r.count), backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 3 }] },
			options: {
				indexAxis: 'y',
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: { legend: { display: false } },
				scales: {
					x: axisOptions(colors, { beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, precision: 0 } }),
					y: axisOptions(colors, { grid: { display: false }, ticks: { color: colors.text, font: { size: 11 }, autoSkip: false } }),
				},
			},
		});
	}

	function sortRows(rows, sort) {
		const { key, dir } = sort;
		return rows.slice().sort((a, b) => {
			const av = a[key];
			const bv = b[key];
			if (typeof av === 'string' || typeof bv === 'string') return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
			return ((av ?? 0) - (bv ?? 0)) * dir;
		});
	}
	function thead(columns, sort) {
		return `<tr>${columns
			.map(c => `<th class="${c.r ? 'r ' : ''}${sort.key === c.key ? 'sorted' : ''}" data-sort="${c.key}">${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`)
			.join('')}</tr>`;
	}

	const PROMPT_COLUMNS = [
		{ key: 'ts', label: 'Time' },
		{ key: 'text', label: 'Prompt' },
		{ key: 'project', label: 'Project' },
		{ key: 'models', label: 'Model' },
		{ key: 'input', label: 'Input', r: true },
		{ key: 'output', label: 'Output', r: true },
		{ key: 'cacheRead', label: 'Cache R', r: true },
		{ key: 'cacheWrite', label: 'Cache W', r: true },
		{ key: 'calls', label: 'Calls', r: true },
		{ key: 'tools', label: 'Tools', r: true },
		{ key: 'cost', label: 'Cost', r: true },
	];
	function updatePrompts(model) {
		const q = ui.promptQuery.trim().toLowerCase();
		let rows = model.prompts;
		if (q) rows = rows.filter(p => (p.text + ' ' + p.project + ' ' + p.models.join(' ')).toLowerCase().includes(q));
		rows = sortRows(rows, ui.promptSort);
		const total = rows.length;
		if (ui.promptRows) rows = rows.slice(0, ui.promptRows);
		slot('prompts', 'thead').innerHTML = thead(PROMPT_COLUMNS, ui.promptSort);
		slot('prompts', 'tbody').innerHTML = rows.length
			? rows
					.map(
						p => `<tr data-file="${esc(p.file)}" title="${esc(p.text)}">
					<td class="num">${esc(stamp(p.ts))}</td><td class="text">${esc(p.text)}</td><td>${esc(p.project)}</td>
					<td>${p.models.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</td>
					<td class="r">${tok(p.input)}</td><td class="r">${tok(p.output)}</td><td class="r">${tok(p.cacheRead)}</td><td class="r">${tok(p.cacheWrite)}</td>
					<td class="r">${p.calls}</td><td class="r">${p.tools}</td><td class="r">${usd(p.cost, true)}</td></tr>`,
					)
					.join('')
			: `<tr><td colspan="${PROMPT_COLUMNS.length}" class="empty">No prompts match.</td></tr>`;
		slot('prompts', 'foot').innerHTML = `<span>Showing ${rows.length} of ${total}${model.prompts.length >= state.settings.historyLimit ? ` (latest ${state.settings.historyLimit}; raise claudeTracker.historyLimit for more)` : ''}</span><span>Click a row to open its transcript</span>`;
	}

	const SESSION_COLUMNS = [
		{ key: 'end', label: 'Last active' },
		{ key: 'title', label: 'Session' },
		{ key: 'project', label: 'Project' },
		{ key: 'prompts', label: 'Prompts', r: true },
		{ key: 'calls', label: 'Calls', r: true },
		{ key: 'tokens', label: 'Tokens', r: true },
		{ key: 'subagentCost', label: 'Subagents', r: true },
		{ key: 'cost', label: 'Cost', r: true },
		{ key: 'actions', label: '' },
	];
	function updateSessions(model) {
		const q = ui.sessionQuery.trim().toLowerCase();
		let rows = model.sessions;
		if (q) rows = rows.filter(s => (s.title + ' ' + s.project + ' ' + s.sessionId + ' ' + s.models.join(' ')).toLowerCase().includes(q));
		rows = sortRows(rows, ui.sessionSort);
		const total = rows.length;
		rows = rows.slice(0, 200);
		slot('sessions', 'thead').innerHTML = thead(SESSION_COLUMNS, ui.sessionSort);
		slot('sessions', 'tbody').innerHTML = rows.length
			? rows
					.map(
						s => `<tr data-file="${esc(s.file || '')}" title="${esc(s.sessionId)}">
					<td class="num">${esc(stamp(s.end))}</td><td class="text">${esc(s.title || s.sessionId.slice(0, 8))} ${s.models.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</td>
					<td>${esc(baseName(s.project))}</td><td class="r">${s.prompts}</td><td class="r">${s.calls}</td><td class="r">${tok(s.tokens)}</td>
					<td class="r">${s.subagentCost ? usd(s.subagentCost) : '—'}</td><td class="r">${usd(s.cost)}</td>
					<td><button class="btn small" type="button" data-action="copyResume" data-session="${esc(s.sessionId)}" title="Copy claude --resume command">Resume</button></td></tr>`,
					)
					.join('')
			: `<tr><td colspan="${SESSION_COLUMNS.length}" class="empty">No sessions in this range.</td></tr>`;
		slot('sessions', 'foot').innerHTML = `<span>Showing ${rows.length} of ${total} sessions</span><span>Duration ${rows[0] ? dur(rows[0].end - rows[0].start) + ' (latest)' : '—'}</span>`;
	}

	function updateCards(model, s) {
		for (const card of CARDS) {
			if (layout.hidden.includes(card.id)) continue;
			try {
				if (card.metric) updateMetric(card, model);
				else if (card.id === 'spend') updateSpend(model);
				else if (card.id === 'live') updateLive(model);
				else if (card.id === 'tokens') updateTokens(model);
				else if (card.id === 'breakdown') updateBreakdown(model);
				else if (card.id === 'models') updateModels(model);
				else if (card.id === 'windows') updateWindows(model, s);
				else if (card.id === 'heatmap') updateHeatmap(model);
				else if (card.id === 'projects') updateProjects(model);
				else if (card.id === 'tools') updateTools(model);
				else if (card.id === 'prompts') updatePrompts(model);
				else if (card.id === 'sessions') updateSessions(model);
			} catch (error) {
				console.error('Card update failed', card.id, error);
			}
		}
	}

	// ---------- layout: order, spans, heights, drag and resize ----------
	function buildGrid() {
		const content = $('content');
		const order = [...layout.order.filter(id => cardById.has(id)), ...CARDS.map(c => c.id).filter(id => !layout.order.includes(id))];
		for (const chart of charts.values()) chart.destroy();
		charts.clear();
		content.innerHTML = order
			.filter(id => !layout.hidden.includes(id))
			.map(id => cardShell(cardById.get(id)))
			.join('');
		content.querySelectorAll('.card').forEach(el => {
			const card = cardById.get(el.dataset.card);
			const size = layout.sizes[card.id] || {};
			el.style.setProperty('--span', String(Math.max(card.minSpan, Math.min(12, size.span || card.span))));
			if (size.height) el.style.height = size.height + 'px';
			wireDrag(el);
		});
		built = true;
	}

	function saveLayout() {
		layout.order = [...$('content').querySelectorAll('.card')].map(el => el.dataset.card).concat(layout.order.filter(id => layout.hidden.includes(id)));
		post({ type: 'saveLayout', layout });
	}

	let dragging = null;
	function wireDrag(el) {
		const head = el.querySelector('.card-head');
		head.addEventListener('pointerdown', event => {
			if (event.target.closest('input,select,button,label')) return;
			el.draggable = true;
		});
		el.addEventListener('dragstart', event => {
			dragging = el;
			el.classList.add('dragging');
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', el.dataset.card);
		});
		el.addEventListener('dragend', () => {
			el.draggable = false;
			el.classList.remove('dragging');
			document.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
			dragging = null;
		});
		el.addEventListener('dragover', event => {
			if (!dragging || dragging === el) return;
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const after = event.clientX > rect.left + rect.width / 2;
			el.classList.toggle('drop-after', after);
			el.classList.toggle('drop-before', !after);
		});
		el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
		el.addEventListener('drop', event => {
			event.preventDefault();
			if (!dragging || dragging === el) return;
			const after = el.classList.contains('drop-after');
			el.classList.remove('drop-before', 'drop-after');
			el.parentElement.insertBefore(dragging, after ? el.nextSibling : el);
			saveLayout();
		});
	}

	// Native CSS resize sets inline width/height; snap width to grid columns when the pointer is released.
	document.addEventListener('pointerup', () => {
		let changed = false;
		const grid = $('content');
		const gap = parseFloat(getComputedStyle(grid).columnGap) || 14;
		const column = (grid.clientWidth - gap * 11) / 12;
		grid.querySelectorAll('.card').forEach(el => {
			const card = cardById.get(el.dataset.card);
			const size = layout.sizes[card.id] || {};
			if (el.style.width) {
				const span = Math.max(card.minSpan, Math.min(12, Math.round((el.getBoundingClientRect().width + gap) / (column + gap))));
				el.style.width = '';
				el.style.setProperty('--span', String(span));
				size.span = span;
				changed = true;
			}
			const height = el.style.height ? Math.round(el.getBoundingClientRect().height) : 0;
			if (height && height !== size.height) {
				size.height = height;
				changed = true;
			}
			layout.sizes[card.id] = size;
		});
		if (changed) {
			for (const chart of charts.values()) chart.resize();
			saveLayout();
		}
	});

	// ---------- settings drawer ----------
	function renderSettings() {
		const s = state.settings;
		const b = state.model.bridge;
		const color = v => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '#888888');
		$('settings').innerHTML = `
			<fieldset><legend>General</legend>
				<label>Default range <select data-key="defaultRange">${RANGES.map(([k, l]) => `<option value="${k}"${s.defaultRange === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
				<label>Show limits as <select data-key="quotaDisplay"><option value="remaining"${s.quotaDisplay === 'remaining' ? ' selected' : ''}>Remaining</option><option value="used"${s.quotaDisplay === 'used' ? ' selected' : ''}>Used</option></select></label>
				<label>Plan price $/mo <input type="number" min="0" step="1" data-key="planMonthlyPriceUsd" value="${s.planMonthlyPriceUsd || 0}"></label>
				<label>Prompt history <input type="number" min="10" max="2000" step="10" data-key="historyLimit" value="${s.historyLimit}"></label>
				<label>Card layout <select data-key="layoutScope"><option value="global"${s.layoutScope === 'global' ? ' selected' : ''}>Global</option><option value="workspace"${s.layoutScope === 'workspace' ? ' selected' : ''}>Workspace</option></select></label>
			</fieldset>
			<fieldset><legend>Thresholds &amp; Colours</legend>
				<label>Warning at % used <input type="number" min="0" max="100" data-key="warningAtUsedPercent" value="${s.warningAtUsedPercent}"></label>
				<label>Critical at % used <input type="number" min="0" max="100" data-key="criticalAtUsedPercent" value="${s.criticalAtUsedPercent}"></label>
				<label title="VS Code only allows the theme's warning (orange) and error (red) colours as status-bar backgrounds">Status bar highlight <select data-key="statusBarHighlight"><option value="background"${s.statusBarHighlight === 'background' ? ' selected' : ''}>Background</option><option value="text"${s.statusBarHighlight === 'text' ? ' selected' : ''}>Text colour</option></select></label>
				<label>Colour scheme <select data-preset="1"><option value="">Choose a preset…</option><option value="traffic">Traffic light</option><option value="cb">Colour-blind safe</option><option value="contrast">High contrast</option></select></label>
				<label>Normal colour <input type="color" data-key="normalColor" data-shown="${color(s.effective.normalColor || tokenHex('accent'))}" value="${color(s.effective.normalColor || tokenHex('accent'))}"></label>
				<label>Warning colour <input type="color" data-key="warningColor" data-shown="${color(s.effective.warningColor)}" value="${color(s.effective.warningColor)}"></label>
				<label>Critical colour <input type="color" data-key="criticalColor" data-shown="${color(s.effective.criticalColor)}" value="${color(s.effective.criticalColor)}"></label>
				<div id="levelPreview" class="level-preview" aria-live="polite"></div>
				<button class="btn small" type="button" data-action="resetColours">Reset colours</button>
				<label><span><input type="checkbox" data-key="notifyOnThreshold"${s.notifyOnThreshold ? ' checked' : ''}> Notify on thresholds</span></label>
				<label><span><input type="checkbox" data-key="showCostInStatusBar"${s.showCostInStatusBar ? ' checked' : ''}> Cost in status bar</span></label>
				<label><span><input type="checkbox" data-key="statusBarShowResets"${s.statusBarShowResets ? ' checked' : ''}> Reset times in status bar</span></label>
				<label><span><input type="checkbox" data-key="outputDebug"${s.outputDebug ? ' checked' : ''}> Debug output</span></label>
			</fieldset>
			${appearanceFieldset(s)}
			<fieldset><legend>Cards</legend>
				<div class="checks">${CARDS.map(c => `<label><input type="checkbox" data-card-toggle="${c.id}"${layout.hidden.includes(c.id) ? '' : ' checked'}> ${esc(c.title)}</label>`).join('')}</div>
			</fieldset>
			<fieldset><legend>Statusline Bridge</legend>
				<div><span class="status-dot ${b.receiving ? 'on' : b.connected ? 'wait' : ''}"></span>${b.receiving ? 'Receiving live limits' : b.connected ? 'Connected, waiting for data' : 'Not connected'}</div>
				<div class="muted" style="font-size:11px;word-break:break-all">${b.connected && b.lastAt ? 'Last update ' + esc(ago(b.lastAt)) : ''}${b.command ? '<br>statusLine: ' + esc(b.command) : ''}</div>
				<div style="display:flex;gap:8px">${b.connected ? '<button class="btn" type="button" data-action="disconnectBridge">Disconnect</button>' : '<button class="btn primary" type="button" data-action="connectBridge">Connect</button>'}<button class="btn" type="button" data-action="showOutput">Output</button></div>
			</fieldset>
			<div class="footer"><span class="meta">v${esc(state.version)} · ${state.model.scan.files} transcripts · ${state.model.scan.records.toLocaleString()} API calls · ${esc(state.model.scan.claudeDir)}</span>
				<button class="btn" type="button" data-action="resetLayout">Reset card layout</button><button class="btn primary" type="button" data-action="saveSettings">Save settings</button></div>`;
		updateLevelPreview();
		updatePaletteStrip(s.effective.theme.palette);
		updateContrastReadout();
	}

	// ---------- appearance: theme, chart palette and colour overrides ----------
	const TOKEN_VARS = { accent: '--accent', marker: '--marker', background: '--surface', surface: '--surface2', text: '--text', mutedText: '--muted', border: '--border' };
	const TOKEN_LABELS = { accent: 'Accent', marker: 'Time marker', background: 'Background', surface: 'Cards', text: 'Text', mutedText: 'Muted text', border: 'Borders' };
	const THEME_LABELS = [
		['vscode', 'Follow VS Code theme (recommended)'],
		['dark', 'Dark'],
		['light', 'Light'],
		['highContrast', 'High contrast'],
	];
	const PALETTE_LABELS = [
		['default', 'Claude (default)'],
		['colorBlindSafe', 'Colour-blind safe'],
		['cool', 'Cool'],
		['warm', 'Warm'],
		['vivid', 'Vivid'],
		['custom', 'Custom…'],
	];
	// True while the drawer holds unsaved appearance changes that are being previewed live.
	let appearanceDirty = false;
	let themeSignature = '';
	let previewTimer = 0;

	function toHex(css) {
		const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(css || '');
		return m ? '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('') : '#888888';
	}
	/** The colour a token currently has on the page, as #rrggbb (works for VS Code theme variables too). */
	function tokenHex(token) {
		return toHex(cssColor(TOKEN_VARS[token], 'rgb(136, 136, 136)'));
	}
	function luminance(hex) {
		const n = parseInt(hex.slice(1), 16);
		const lin = v => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	}
	function contrast(a, b) {
		const x = luminance(a);
		const y = luminance(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	}
	/** Black or white, whichever reads better on the accent colour (used for primary buttons). */
	function onAccent(hex) {
		return contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111';
	}

	function applyTokens(tokens, scheme, forced) {
		const style = document.documentElement.style;
		for (const [key, name] of Object.entries(TOKEN_VARS)) {
			if (tokens[key]) style.setProperty(name, tokens[key]);
			else style.removeProperty(name);
		}
		// Input fields derive from the page colours only when those are changed from the editor's own.
		if (tokens.background || tokens.surface || tokens.text) style.setProperty('--input', 'color-mix(in srgb, var(--text) 9%, var(--surface))');
		else style.removeProperty('--input');
		if (tokens.accent) style.setProperty('--on-accent', onAccent(tokens.accent));
		else style.removeProperty('--on-accent');
		if (scheme) style.setProperty('color-scheme', scheme);
		else style.removeProperty('color-scheme');
		document.documentElement.toggleAttribute('data-forced', Boolean(forced));
	}

	/** Swaps the chart colours in place; everything that draws with PALETTE / CONTRAST / EFFORT_COLORS reads them live. */
	function applyPalette(palette, contrastColors, critical) {
		PALETTE.splice(0, PALETTE.length, ...palette);
		CONTRAST.splice(0, CONTRAST.length, ...contrastColors);
		Object.assign(EFFORT_COLORS, { low: PALETTE[1], medium: PALETTE[3], high: PALETTE[2], xhigh: PALETTE[0], max: critical || '#e5484d', 'not set': PALETTE[7] });
	}
	function resetCharts() {
		for (const chart of charts.values()) chart.destroy();
		charts.clear();
	}

	function applyTheme(t, critical) {
		applyTokens(t.tokens, t.scheme, t.forced);
		const signature = JSON.stringify([t.palette, t.contrast, critical]);
		applyPalette(t.palette, t.contrast, critical);
		// Charts bake their colours in when created, so a palette change rebuilds them on the next update.
		if (signature !== themeSignature) {
			themeSignature = signature;
			resetCharts();
		}
	}
	/** Drops an unsaved preview and goes back to the saved appearance. */
	function revertAppearance() {
		appearanceDirty = false;
		const e = state.settings.effective;
		applyTheme(e.theme, e.criticalColor);
		updateCards(state.model, state.settings);
	}

	const originalTheme = () => state.settings.theme || 'vscode';
	const schemeOf = theme => (theme === originalTheme() ? state.settings.effective.theme.scheme : theme === 'vscode' ? null : state.settings.catalog.themes[theme].scheme);
	/** Colours of a theme as the drawer should show them: the saved result (with overrides) for the current theme, the plain preset otherwise. */
	function baseTokens(theme) {
		if (theme === originalTheme()) return state.settings.effective.theme.tokens;
		return theme === 'vscode' ? {} : state.settings.catalog.themes[theme];
	}

	function appearanceFieldset(s) {
		const select = (key, value, options) =>
			`<select data-key="${key}">${options.map(([k, l]) => `<option value="${k}"${value === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
		const pickers = Object.keys(TOKEN_VARS)
			.map(key => {
				const hex = tokenHex(key);
				return `<label>${TOKEN_LABELS[key]} <input type="color" data-token="${key}" data-shown="${hex}" value="${hex}"></label>`;
			})
			.join('');
		const series = s.effective.theme.palette.map((c, i) => `<input type="color" data-series="${i}" data-shown="${c}" value="${c}" title="Series ${i + 1}">`).join('');
		return `<fieldset class="appearance"><legend>Appearance</legend>
				<label>Theme ${select('theme', s.theme || 'vscode', THEME_LABELS)}</label>
				${pickers}
				<label>Chart colours ${select('chartPalette', s.chartPalette || 'default', PALETTE_LABELS)}</label>
				<div id="paletteStrip" class="palette-strip" aria-hidden="true"></div>
				<div id="seriesPickers" class="series-pickers"${s.chartPalette === 'custom' ? '' : ' hidden'}>${series}</div>
				<div id="contrastReadout" class="contrast-readout" aria-live="polite"></div>
				<p class="reco"><strong>Recommended:</strong> keep “Follow VS Code theme”, which stays readable in every editor theme. Choose “Colour-blind safe” charts if orange, green and red are hard to tell apart, and keep text contrast at 4.5:1 or higher. The status bar always follows your VS Code theme.</p>
				<button class="btn small" type="button" data-action="resetAppearance">Reset appearance</button>
			</fieldset>`;
	}

	function readSeries() {
		return [...$('settings').querySelectorAll('[data-series]')].map(el => el.value);
	}
	function updatePaletteStrip(series) {
		const strip = $('paletteStrip');
		if (strip) strip.innerHTML = series.map(c => `<i style="background:${c}"></i>`).join('');
	}
	function updateContrastReadout() {
		const box = $('contrastReadout');
		if (!box) return;
		const v = key => $('settings').querySelector(`[data-token="${key}"]`).value;
		const rows = [
			['Text on background', v('text'), v('background'), 4.5],
			['Text on cards', v('text'), v('surface'), 4.5],
			['Muted text on background', v('mutedText'), v('background'), 3],
		];
		box.innerHTML =
			rows
				.map(([label, a, b, min]) => {
					const ratio = contrast(a, b);
					return `<span class="cr ${ratio >= min ? 'ok' : 'bad'}">${ratio >= min ? '✓' : '⚠'} ${label}: ${ratio.toFixed(1)}:1</span>`;
				})
				.join('') + '<span class="muted cr-note">4.5:1 or more is easy to read</span>';
	}

	/** Applies the drawer's current theme, overrides and palette to the page without saving. */
	function previewAppearance() {
		clearTimeout(previewTimer);
		const root = $('settings');
		const theme = root.querySelector('[data-key="theme"]').value;
		const paletteName = root.querySelector('[data-key="chartPalette"]').value;
		const tokens = { ...baseTokens(theme) };
		root.querySelectorAll('[data-token]').forEach(el => {
			if (el.value !== el.dataset.shown) tokens[el.dataset.token] = el.value;
		});
		applyTokens(tokens, schemeOf(theme), theme !== 'vscode');
		let palette;
		if (paletteName === 'custom') {
			const series = readSeries();
			palette = { series, contrast: Array.from({ length: 12 }, (_, i) => series[i % series.length]) };
		} else {
			palette = state.settings.catalog.palettes[paletteName];
		}
		applyPalette(palette.series, palette.contrast, state.settings.effective.criticalColor);
		themeSignature = '';
		resetCharts();
		updateCards(state.model, state.settings);
		updatePaletteStrip(palette.series);
		updateContrastReadout();
		appearanceDirty = true;
	}
	const schedulePreview = () => {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(previewAppearance, 120);
	};

	function onThemeChanged(theme) {
		const base = baseTokens(theme);
		// Clear forced colours first so the "Follow VS Code" pickers read the editor's own values.
		applyTokens(base, schemeOf(theme), theme !== 'vscode');
		$('settings')
			.querySelectorAll('[data-token]')
			.forEach(el => {
				const hex = base[el.dataset.token] || tokenHex(el.dataset.token);
				el.value = hex;
				el.dataset.shown = hex;
			});
		previewAppearance();
	}
	function onPaletteChanged(name) {
		const box = $('seriesPickers');
		box.hidden = name !== 'custom';
		const source = name === 'custom' ? PALETTE.slice() : state.settings.catalog.palettes[name].series;
		box.querySelectorAll('[data-series]').forEach((el, i) => {
			el.value = source[i];
			el.dataset.shown = source[i];
		});
		previewAppearance();
	}

	/** Adds the appearance fields to the settings payload. Overrides are saved only when changed; switching theme drops old overrides. */
	function collectAppearance(values) {
		const root = $('settings');
		if (!root.querySelector('[data-key="theme"]')) return;
		const saved = state.settings;
		const themeChanged = values.theme !== originalTheme();
		const colors = themeChanged ? {} : { ...(saved.colors || {}) };
		let changed = themeChanged;
		root.querySelectorAll('[data-token]').forEach(el => {
			if (el.value !== el.dataset.shown) {
				colors[el.dataset.token] = el.value;
				changed = true;
			}
		});
		if (changed) values.colors = Object.keys(colors).length ? colors : null;
		if (values.chartPalette === 'custom') values.customChartColors = readSeries();
	}

	const ACCENT_HEX = '#d97757';
	const PRESETS = {
		traffic: { normalColor: '#3fb950', warningColor: '#e8a23a', criticalColor: '#e5484d' },
		cb: { normalColor: '#56b4e9', warningColor: '#f0e442', criticalColor: '#cc79a7' },
		contrast: { normalColor: '#ffffff', warningColor: '#ffd400', criticalColor: '#ff3b30' },
	};

	/** Shows the three level ranges for the thresholds and colours currently typed in the drawer, in the chosen display mode. */
	function updateLevelPreview() {
		const box = $('levelPreview');
		if (!box) return;
		const read = key => $('settings').querySelector('[data-key="' + key + '"]');
		const warning = Math.min(100, Math.max(0, Math.round(Number(read('warningAtUsedPercent').value) || 0)));
		const critical = Math.min(100, Math.max(warning, Math.round(Number(read('criticalAtUsedPercent').value) || 0)));
		const used = read('quotaDisplay').value === 'used';
		// Used percentages as inclusive [from, to]; remaining mirrors them around 100.
		const ranges = [
			['Normal', 'normalColor', warning > 0 ? [0, warning - 1] : null],
			['Warning', 'warningColor', critical > warning ? [warning, critical - 1] : null],
			['Critical', 'criticalColor', [critical, 100]],
		];
		box.innerHTML = ranges
			.map(([name, key, r]) => {
				const text = !r ? 'none' : used ? r[0] + '–' + r[1] + '%' : 100 - r[0] + '–' + (100 - r[1]) + '%';
				return '<span class="lv" style="--lc:' + esc(read(key).value) + '">' + name + ' ' + text + '</span>';
			})
			.join('') + '<span class="muted lv-note">' + (used ? 'used' : 'left') + '</span>';
	}

	function collectSettings() {
		const values = {};
		$('settings')
			.querySelectorAll('[data-key]')
			.forEach(el => {
				const key = el.dataset.key;
				if (el.type === 'checkbox') values[key] = el.checked;
				else if (el.type === 'number') values[key] = Number(el.value);
				// Colours are only saved when changed, so an untouched normal colour stays on the theme default.
				else if (el.type === 'color') {
					if (el.value !== el.dataset.shown) values[key] = el.value;
				}
				else values[key] = el.value;
			});
		collectAppearance(values);
		return values;
	}

	// ---------- events ----------
	document.addEventListener('click', event => {
		const target = event.target.closest('[data-range],[data-dim],[data-action],[data-sort],tr[data-file],#settingsToggle,#refreshButton,#displayToggle');
		if (!target) return;
		if (target.id === 'settingsToggle') {
			const panel = $('settings');
			panel.hidden = !panel.hidden;
			target.setAttribute('aria-expanded', String(!panel.hidden));
			if (!panel.hidden && state) renderSettings();
			if (panel.hidden && state && appearanceDirty) revertAppearance();
			return;
		}
		if (target.id === 'displayToggle') {
			post({ type: 'saveSettings', values: { quotaDisplay: usedMode() ? 'remaining' : 'used' } });
			return;
		}
		if (target.id === 'refreshButton') {
			target.classList.add('spinning');
			post({ type: 'refresh' });
			return;
		}
		if (target.dataset.dim) {
			// Toggle independently; at least one dimension stays selected.
			const dim = target.dataset.dim;
			const selected = ui.breakdownDims.includes(dim) ? ui.breakdownDims.filter(d => d !== dim) : [...ui.breakdownDims, dim];
			if (!selected.length) return;
			ui.breakdownDims = ['model', 'effort'].filter(d => selected.includes(d));
			saveUi();
			target.parentElement.querySelectorAll('[data-dim]').forEach(b => {
				const on = ui.breakdownDims.includes(b.dataset.dim);
				b.classList.toggle('active', on);
				b.setAttribute('aria-pressed', String(on));
			});
			updateBreakdown(state.model);
			return;
		}
		if (target.dataset.range) {
			post({ type: 'setRange', range: target.dataset.range });
			return;
		}
		if (target.dataset.sort) {
			const table = target.closest('[data-card]').dataset.card;
			const sort = table === 'prompts' ? ui.promptSort : ui.sessionSort;
			if (target.dataset.sort === 'actions') return;
			if (sort.key === target.dataset.sort) sort.dir *= -1;
			else Object.assign(sort, { key: target.dataset.sort, dir: target.dataset.sort === 'text' || target.dataset.sort === 'title' || target.dataset.sort === 'project' ? 1 : -1 });
			saveUi();
			if (table === 'prompts') updatePrompts(state.model);
			else updateSessions(state.model);
			return;
		}
		const action = target.dataset.action;
		if (action) {
			event.stopPropagation();
			switch (action) {
				case 'connectBridge':
				case 'disconnectBridge':
				case 'showOutput':
				case 'openClaudeTerminal':
				case 'resetLayout':
					if (action === 'resetLayout') {
						layout = { order: [], sizes: {}, hidden: [] };
						buildGrid();
						updateCards(state.model, state.settings);
					}
					post({ type: action });
					return;
				case 'resetAppearance':
					appearanceDirty = false;
					post({ type: 'saveSettings', values: { theme: null, chartPalette: null, customChartColors: null, colors: null } });
					$('settings').hidden = true;
					$('settingsToggle').setAttribute('aria-expanded', 'false');
					return;
				case 'resetColours':
					post({ type: 'saveSettings', values: { normalColor: null, warningColor: null, criticalColor: null } });
					$('settings').hidden = true;
					$('settingsToggle').setAttribute('aria-expanded', 'false');
					return;
				case 'dismissBanner':
					ui.bannerDismissed = true;
					saveUi();
					$('bridgeBanner').hidden = true;
					return;
				case 'export':
					post({ type: 'export', format: target.dataset.format });
					return;
				case 'copyResume':
					post({ type: 'copyResume', sessionId: target.dataset.session });
					return;
				case 'saveSettings': {
					appearanceDirty = false;
					const hidden = [...$('settings').querySelectorAll('[data-card-toggle]')].filter(el => !el.checked).map(el => el.dataset.cardToggle);
					if (hidden.join() !== layout.hidden.join()) {
						layout.hidden = hidden;
						buildGrid();
						updateCards(state.model, state.settings);
						saveLayout();
					}
					post({ type: 'saveSettings', values: collectSettings() });
					$('settings').hidden = true;
					$('settingsToggle').setAttribute('aria-expanded', 'false');
					return;
				}
			}
			return;
		}
		if (target.matches('tr[data-file]') && target.dataset.file) post({ type: 'openFile', file: target.dataset.file });
	});

	document.addEventListener('input', event => {
		const el = event.target;
		if (el.closest && el.closest('#settings') && (el.type === 'color' || el.type === 'number')) updateLevelPreview();
		if (el.dataset.slot === 'search') {
			const table = el.closest('[data-card]').dataset.card;
			if (table === 'prompts') {
				ui.promptQuery = el.value;
				updatePrompts(state.model);
			} else {
				ui.sessionQuery = el.value;
				updateSessions(state.model);
			}
			saveUi();
		}
	});
	document.addEventListener('change', event => {
		const el = event.target;
		if (el.dataset.preset !== undefined) {
			const preset = PRESETS[el.value];
			if (preset) {
				for (const [key, value] of Object.entries(preset)) $('settings').querySelector('[data-key="' + key + '"]').value = value;
				updateLevelPreview();
			}
			return;
		}
		if (el.closest('#settings') && el.dataset.key === 'quotaDisplay') updateLevelPreview();
		if (el.dataset.slot === 'metric') {
			ui.breakdownMetric = el.value;
			saveUi();
			updateBreakdown(state.model);
			return;
		}
		if (el.dataset.slot === 'rows') {
			ui.promptRows = Number(el.value);
			saveUi();
			updatePrompts(state.model);
		}
	});

	const tooltip = $('tooltip');
	document.addEventListener('mouseover', event => {
		const el = event.target.closest('[data-tip]');
		if (!el) {
			tooltip.hidden = true;
			return;
		}
		tooltip.textContent = el.dataset.tip;
		tooltip.hidden = false;
		const rect = el.getBoundingClientRect();
		const left = Math.min(window.innerWidth - tooltip.offsetWidth - 8, Math.max(8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2));
		const top = rect.top - tooltip.offsetHeight - 6 < 4 ? rect.bottom + 6 : rect.top - tooltip.offsetHeight - 6;
		tooltip.style.left = left + 'px';
		tooltip.style.top = top + 'px';
	});

	// ---------- state ----------
	window.addEventListener('message', event => {
		const message = event.data;
		if (!message || message.type !== 'state') return;
		// The webview owns the layout after the first state; later states may carry a copy older than an in-flight save.
		if (!built) {
			const incoming = message.layout || {};
			layout = { order: incoming.order || [], sizes: incoming.sizes || {}, hidden: incoming.hidden || [] };
		}
		state = message;
		applyColours(message.settings);
		if (!appearanceDirty) applyTheme(message.settings.effective.theme, message.settings.effective.criticalColor);
		const toggle = $('displayToggle');
		toggle.textContent = usedMode() ? 'Showing: Used' : 'Showing: Left';
		toggle.title = usedMode() ? 'Showing how much is used. Click to show how much is left.' : 'Showing how much is left. Click to show how much is used.';
		if (!built) buildGrid();
		const { model, settings } = state;
		renderRanges(model);
		renderQuotaStrip(model, settings);
		renderMeters(model, settings);
		renderBanner(model);
		updateCards(model, settings);
		$('refreshButton').classList.remove('spinning');
		const updated = $('updated');
		updated.textContent = `Updated ${new Date(model.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
		updated.title = `${model.scan.files} transcripts · ${model.scan.records.toLocaleString()} API calls · ${model.scan.prompts.toLocaleString()} prompts · scanned in ${model.scan.durationMs}ms`;
	});

	// Appearance controls: preview live while the drawer is open.
	document.addEventListener('change', event => {
		const el = event.target;
		if (!state || !el.closest || !el.closest('#settings')) return;
		if (el.dataset.key === 'theme') onThemeChanged(el.value);
		else if (el.dataset.key === 'chartPalette') onPaletteChanged(el.value);
		else if (el.dataset.token || el.dataset.series !== undefined) previewAppearance();
	});
	document.addEventListener('input', event => {
		const el = event.target;
		if (!state || !el.closest || !el.closest('#settings')) return;
		if (el.dataset.token || el.dataset.series !== undefined) schedulePreview();
	});

	post({ type: 'ready' });
})();
