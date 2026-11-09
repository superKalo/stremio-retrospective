import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveUtcDate, historicalDates, parseCalendarDate } from '../src/dates.ts';

test('uses the same UTC rollover in timezones on opposite sides of midnight', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      process.env.TZ = timezone;
      const before = new Date('2025-12-31T23:59:59.999Z');
      const after = new Date('2026-01-01T00:00:00.000Z');
      assert.equal(before.getDate(), after.getDate(), timezone);
      assert.equal(effectiveUtcDate(before), '2025-12-31', timezone);
      assert.equal(effectiveUtcDate(after), '2026-01-01', timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('rejects invalid Gregorian dates and local overrides outside the supported range', () => {
  for (const invalid of [
    '2026-2-09', '2026-02-29', '2100-02-29', '2026-04-31', '0000-01-01',
    '2026-00-01', '2026-12-00', '2026-11-09\n', '2026-11-09T00:00:00Z',
  ]) {
    assert.throws(() => parseCalendarDate(invalid), RangeError, invalid);
  }
  const now = new Date('2026-11-09T00:00:00Z');
  assert.equal(effectiveUtcDate(now, '2026-11-09'), '2026-11-09');
  assert.equal(effectiveUtcDate(now, '1951-01-01'), '1951-01-01');
  assert.throws(() => effectiveUtcDate(now, '2026-11-10'), RangeError);
  assert.throws(() => effectiveUtcDate(now, '1950-12-31'), RangeError);
});

test('includes 1950 and excludes the effective year across the year boundary', () => {
  assert.deepEqual(historicalDates('1951-01-01'), ['1950-01-01']);
  assert.equal(historicalDates('2025-12-31').at(-1), '2024-12-31');
  assert.equal(historicalDates('2026-01-01').at(-1), '2025-01-01');
  assert.equal(historicalDates('2026-11-09').length, 76);
});

test('uses exact month and day for February 29 and its neighboring dates', () => {
  const leapDates = historicalDates('2104-02-29');
  assert.equal(leapDates[0], '1952-02-29');
  assert(leapDates.includes('2000-02-29'));
  assert(!leapDates.includes('2100-02-29'));
  assert.equal(leapDates.at(-1), '2096-02-29');
  assert(historicalDates('2104-02-28').includes('2100-02-28'));
  assert(historicalDates('2104-03-01').includes('2100-03-01'));
});
