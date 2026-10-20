import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgentSummary, formatChinaTime } from '../extensions/summary.ts';

const data = { commands: 3, reads: 0, edits: 0, writes: 0, others: 0, failed: 0, durationMs: 36_000 };

test('appends the completion wall clock after duration in UTC+8', () => {
  assert.equal(formatAgentSummary(data, '2026-01-01T16:23:45.000Z'), '> *Ran 3 commands · 36s · 00:23:45 (UTC+8)*');
});

test('preserves tool summary categories, failures, duration and time on the same line', () => {
  assert.equal(formatAgentSummary({ ...data, commands: 1, reads: 2, failed: 1, durationMs: 61_000 }, '2026-06-01T05:04:03Z'), '> *Ran 1 command, read 2 files, 1 failed · 1m 1s · 13:04:03 (UTC+8)*');
});

test('invalid or missing entry timestamps do not produce a fake clock', () => {
  assert.equal(formatAgentSummary(data, undefined), '> *Ran 3 commands · 36s*');
  assert.equal(formatAgentSummary(data, 'not-a-date'), '> *Ran 3 commands · 36s*');
  assert.equal(formatAgentSummary({ ...data, commands: 0 }, '2026-01-01T00:00:00Z'), '');
});

test('format uses Asia/Shanghai rather than machine locale, including across UTC midnight', () => {
  assert.equal(formatChinaTime('2026-10-20T23:59:59Z'), '07:59:59 (UTC+8)');
  assert.equal(formatChinaTime('2026-01-01T00:00:00Z'), '08:00:00 (UTC+8)');
});
