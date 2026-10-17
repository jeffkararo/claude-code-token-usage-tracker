export function formatUsd(value: number, precise = false): string {
	if (!Number.isFinite(value)) return '$0.00';
	if (precise || Math.abs(value) < 10) return `$${value.toFixed(2)}`;
	if (Math.abs(value) < 1000) return `$${value.toFixed(1)}`;
	return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value === 0) return '0';
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
	if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
	return String(Math.round(value));
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return '—';
	const minutes = Math.max(0, Math.round(ms / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatClock(ts: number, now = Date.now()): string {
	const d = new Date(ts);
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (new Date(now).toDateString() === d.toDateString()) return time;
	return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
