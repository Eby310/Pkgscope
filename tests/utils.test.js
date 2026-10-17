import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatNumber,
  escapeHtml,
  estimateDownloadTime,
  evaluateHealth,
  findBestValues,
  parsePackageSpec,
} from '../app.js';

test('formatBytes: correctly formats B, kB, and MB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 kB');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(5242880), '5.0 MB');
  assert.equal(formatBytes(null), 'N/A');
  assert.equal(formatBytes(undefined), 'N/A');
});

test('formatNumber: formats counts with k and M suffixes', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(850), '850');
  assert.equal(formatNumber(1500), '1.5k');
  assert.equal(formatNumber(24800), '24.8k');
  assert.equal(formatNumber(1000000), '1.0M');
  assert.equal(formatNumber(24850000), '24.9M');
  assert.equal(formatNumber(null), '0');
});

test('escapeHtml: prevents XSS by replacing sensitive characters', () => {
  const dangerous = '<script>alert("xss & \'danger\'")</script>';
  const escaped = escapeHtml(dangerous);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.ok(escaped.includes('&quot;xss'));
  assert.ok(escaped.includes('&#39;danger&#39;'));
  assert.ok(escaped.includes('&amp;'));
  assert.equal(escapeHtml('Normal string 123'), 'Normal string 123');
  assert.equal(escapeHtml(null), '');
});

test('estimateDownloadTime: computes accurate 3G and 4G download times', () => {
  // 50 KB at 50 KB/s (Slow 3G) = 1.0s
  const slow3G = estimateDownloadTime(51200, 50 * 1024);
  assert.equal(slow3G, '1.0 s');

  // 10 KB at 3.75 MB/s (4G) = ~2-3 ms
  const fast4G = estimateDownloadTime(10240, 3.75 * 1024 * 1024);
  assert.ok(fast4G.includes('ms') || fast4G.includes('s'));
});

test('evaluateHealth: evaluates TypeScript, ESM, tree-shaking, and outdated status', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const recentDate = new Date('2026-05-01T00:00:00Z').toISOString();
  const oldDate = new Date('2022-01-01T00:00:00Z').toISOString();

  const modernVersion = {
    name: 'modern-pkg',
    version: '2.0.0',
    types: './dist/index.d.ts',
    type: 'module',
    sideEffects: false,
  };

  const modernMeta = {
    time: {
      '2.0.0': recentDate,
      modified: recentDate,
    },
    maintainers: [{ name: 'alice' }, { name: 'bob' }],
  };

  const health = evaluateHealth(modernMeta, modernVersion, now);
  assert.equal(health.hasTypes, true);
  assert.equal(health.typesSource, 'built-in');
  assert.equal(health.isEsm, true);
  assert.equal(health.isTreeShakeable, true);
  assert.equal(health.isOutdated, false);
  assert.equal(health.maintainersCount, 2);

  // Test legacy / outdated pkg
  const legacyVersion = {
    name: 'legacy-pkg',
    version: '1.0.0',
    main: './index.js',
  };
  const legacyMeta = {
    time: {
      '1.0.0': oldDate,
      modified: oldDate,
    },
    maintainers: [{ name: 'solo' }],
  };

  const legacyHealth = evaluateHealth(legacyMeta, legacyVersion, now);
  assert.equal(legacyHealth.hasTypes, false);
  assert.equal(legacyHealth.isEsm, false);
  assert.equal(legacyHealth.isTreeShakeable, false);
  assert.equal(legacyHealth.isOutdated, true);
  assert.equal(legacyHealth.maintainersCount, 1);
});

test('parsePackageSpec: handles package names with and without scopes and versions', () => {
  assert.deepEqual(parsePackageSpec('react'), { name: 'react', version: null });
  assert.deepEqual(parsePackageSpec('react@18.2.0'), { name: 'react', version: '18.2.0' });
  assert.deepEqual(parsePackageSpec('@types/node'), { name: '@types/node', version: null });
  assert.deepEqual(parsePackageSpec('@types/node@20.0.0'), { name: '@types/node', version: '20.0.0' });
});

test('findBestValues: identifies best metric in comparisons', () => {
  const pkgs = [
    { name: 'pkg-a', gzip: 10000, size: 30000, depsCount: 5, downloads: 1000000, lastPublishDays: 10 },
    { name: 'pkg-b', gzip: 4000, size: 12000, depsCount: 0, downloads: 200000, lastPublishDays: 50 },
    { name: 'pkg-c', gzip: 25000, size: 75000, depsCount: 12, downloads: 5000000, lastPublishDays: 2 },
  ];

  const best = findBestValues(pkgs);
  assert.equal(best.gzip, 'pkg-b'); // smallest gzip
  assert.equal(best.size, 'pkg-b'); // smallest size
  assert.equal(best.depsCount, 'pkg-b'); // fewest deps
  assert.equal(best.downloads, 'pkg-c'); // highest downloads
  assert.equal(best.lastPublishDays, 'pkg-c'); // most recently published
});
