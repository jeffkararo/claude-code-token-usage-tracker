const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseUsageText, parseReset, zonedTime, saveReport } = require('../out/usagePoller');

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 34% used · resets Oct 14, 6:59pm (America/Chicago)
Current week (all models): 5% used · resets Oct 16, 2:59am (America/Chicago)
Current week (Opus): 12.5% used · resets Oct 16, 2:59am (America/Chicago)

What's contributing to your limits usage?`;

// 2026-10-14 16:00 Chicago (CDT, UTC-5) = 21:00 UTC
const now = Date.UTC(2026, 9, 14, 21, 0);

test('converts wall-clock times in an IANA zone', () => {
	assert.equal(zonedTime(2026, 9, 14, 18, 59, 'America/Chicago'), Date.UTC(2026, 9, 14, 23, 59));
	assert.equal(zonedTime(2026, 0, 14, 18, 59, 'America/Chicago'), Date.UTC(2026, 0, 15, 0, 59), 'CST is UTC-6');
	assert.equal(zonedTime(2026, 9, 14, 9, 0, 'Europe/London'), Date.UTC(2026, 9, 14, 8, 0));
});

test('parses reset times with and without a date', () => {
	assert.equal(parseReset('Oct 14, 6:59pm (America/Chicago)', now), Date.UTC(2026, 9, 14, 23, 59));
	assert.equal(parseReset('Oct 16, 2:59am (America/Chicago)', now), Date.UTC(2026, 9, 16, 7, 59));
	assert.equal(parseReset('12pm (America/Chicago)', now), Date.UTC(2026, 9, 15, 17, 0), 'time already passed today rolls to tomorrow');
	assert.equal(parseReset('Jan 2, 1am (America/Chicago)', now), Date.UTC(2027, 0, 2, 7, 0), 'early-year date rolls into next year');
	assert.equal(parseReset('soon', now), null);
});

test('extracts the session, weekly and model-specific windows from /usage text', () => {
	const report = parseUsageText(SAMPLE, now);
	assert.equal(report.subscription, true);
	assert.equal(report.fiveHour.usedPercent, 34);
	assert.equal(report.fiveHour.resetsAt, Date.UTC(2026, 9, 14, 23, 59));
	assert.equal(report.sevenDay.usedPercent, 5);
	assert.equal(report.other.length, 1);
	assert.equal(report.other[0].label, 'week (Opus)');
	assert.equal(report.other[0].usedPercent, 12.5);
	assert.deepEqual(parseUsageText('You are using an API key', now), { other: [], subscription: false });
});

test('saves polled windows in the bridge file format and appends history on change', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-poll-'));
	const report = parseUsageText(SAMPLE, now);
	assert.equal(await saveReport(dir, report, now), true);
	const saved = JSON.parse(fs.readFileSync(path.join(dir, 'rate-limits.json'), 'utf8'));
	assert.equal(saved.source, 'usage-poll');
	assert.equal(saved.rateLimits.five_hour.used_percentage, 34);
	assert.equal(saved.rateLimits.five_hour.resets_at, Date.UTC(2026, 9, 14, 23, 59) / 1000);
	await saveReport(dir, report, now + 60_000);
	report.fiveHour.usedPercent = 40;
	await saveReport(dir, report, now + 120_000);
	const history = fs.readFileSync(path.join(dir, 'rate-history.jsonl'), 'utf8').trim().split('\n');
	assert.equal(history.length, 2);
	assert.equal(await saveReport(dir, { other: [], subscription: false }, now), false);
	fs.rmSync(dir, { recursive: true, force: true });
});
