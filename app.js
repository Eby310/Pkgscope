/**
 * PkgScope — npm Package Size & Dependency Explorer
 * Vanilla JavaScript (ES Module, zero build step, no frameworks)
 *
 * Sections:
 * 1. Constants & Configuration
 * 2. Pure Logic & Formatting Utilities (Exported for testability)
 * 3. Network & Caching API Layer (With 10s timeout, memory + sessionStorage cache, and jsDelivr fallback)
 * 4. Application State
 * 5. Canvas Chart Drawing Helpers (Downloads trend, Version bloat, Compare bar chart)
 * 6. DOM Rendering Functions
 * 7. Event Handlers & User Interactions
 * 8. Initialization & URL Routing
 */

// ============================================================================
// 1. Constants & Configuration
// ============================================================================

const CONFIG = {
  TIMEOUT_MS: 10000,
  SPEED_SLOW_3G_BPS: 50 * 1024, // 50 KB/s (~400 Kbps)
  SPEED_4G_BPS: 3.75 * 1024 * 1024, // 3.75 MB/s (~30 Mbps)
  MAX_TREE_DEPTH: 3,
  MAX_COMPARE_ITEMS: 4,
  MAX_VERSION_HISTORY: 15,
  SESSION_CACHE_PREFIX: 'pkgscope_cache_',
  STORAGE_KEYS: {
    RECENT: 'pkgscope_recent_searches',
    THEME: 'pkgscope_theme',
  },
  POPULAR_PACKAGES: ['react', 'lodash', 'axios', 'express', 'dayjs', 'zod'],
};

// ============================================================================
// 2. Pure Logic & Formatting Utilities
// ============================================================================

/**
 * Format raw byte size into B, kB, or MB
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return 'N/A';
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'kB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const safeI = Math.min(i, sizes.length - 1);
  const value = bytes / Math.pow(k, safeI);

  return `${value.toFixed(safeI === 0 ? 0 : 1)} ${sizes[safeI]}`;
}

/**
 * Format download counts with k and M suffixes
 * @param {number|null|undefined} num
 * @returns {string}
 */
export function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return num.toLocaleString();
}

/**
 * Escape HTML to prevent XSS injection from package metadata
 * @param {any} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Compute estimated download duration
 * @param {number} bytes
 * @param {number} speedBps
 * @returns {string}
 */
export function estimateDownloadTime(bytes, speedBps) {
  if (!bytes || !speedBps) return '--';
  const seconds = bytes / speedBps;
  if (seconds < 0.1) {
    const ms = Math.round(seconds * 1000);
    return `${ms} ms`;
  }
  return `${seconds.toFixed(1)} s`;
}

/**
 * Parse package spec into name and version: e.g. "react@18.2.0" or "@types/node@20"
 * @param {string} spec
 * @returns {{ name: string, version: string|null }}
 */
export function parsePackageSpec(spec) {
  if (!spec) return { name: '', version: null };
  const trimmed = spec.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex > 0) {
    return {
      name: trimmed.substring(0, atIndex),
      version: trimmed.substring(atIndex + 1) || null,
    };
  }
  return { name: trimmed, version: null };
}

/**
 * Evaluate package health indicators
 * @param {object} pkgMeta - Full registry metadata
 * @param {object} versionObj - Package.json data for selected version
 * @param {Date} [now]
 */
export function evaluateHealth(pkgMeta, versionObj, now = new Date()) {
  const versionData = versionObj || {};
  const meta = pkgMeta || {};

  // 1. TypeScript types: check types, typings, or exports containing types
  let hasTypes = Boolean(
    versionData.types ||
      versionData.typings ||
      (versionData.exports && JSON.stringify(versionData.exports).includes('.d.ts'))
  );
  let typesSource = hasTypes ? 'built-in' : 'none';

  // 2. ESM Support: check "type": "module", "module" field, or modern exports
  let isEsm = Boolean(
    versionData.type === 'module' ||
      versionData.module ||
      versionData['jsnext:main'] ||
      (versionData.exports && JSON.stringify(versionData.exports).includes('import'))
  );

  // 3. Tree Shakeable: sideEffects field (false or array of non-effect files)
  let isTreeShakeable = false;
  if (versionData.sideEffects === false) {
    isTreeShakeable = true;
  } else if (Array.isArray(versionData.sideEffects)) {
    isTreeShakeable = true;
  }

  // 4. Maintenance / Last release date
  let lastPublishDate = null;
  let isOutdated = false;
  let daysSincePublish = 0;

  if (meta.time) {
    const ver = versionData.version;
    const timeStr = (ver && meta.time[ver]) || meta.time.modified || Object.values(meta.time).pop();
    if (timeStr) {
      lastPublishDate = new Date(timeStr);
      const diffMs = now.getTime() - lastPublishDate.getTime();
      daysSincePublish = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (daysSincePublish > 730) {
        // > 2 years
        isOutdated = true;
      }
    }
  }

  // 5. Maintainers count
  const maintainersCount = Array.isArray(meta.maintainers) ? meta.maintainers.length : 1;

  return {
    hasTypes,
    typesSource,
    isEsm,
    isTreeShakeable,
    isOutdated,
    lastPublishDate,
    daysSincePublish,
    maintainersCount,
  };
}

/**
 * Find best metrics in compare mode
 * @param {Array<object>} packages
 */
export function findBestValues(packages) {
  if (!packages || packages.length === 0) return {};

  const best = {
    gzip: null,
    size: null,
    depsCount: null,
    downloads: null,
    lastPublishDays: null,
  };

  let minGzip = Infinity;
  let minSize = Infinity;
  let minDeps = Infinity;
  let maxDownloads = -1;
  let minDaysSincePublish = Infinity;

  packages.forEach((pkg) => {
    if (pkg.gzip && pkg.gzip < minGzip) {
      minGzip = pkg.gzip;
      best.gzip = pkg.name;
    }
    if (pkg.size && pkg.size < minSize) {
      minSize = pkg.size;
      best.size = pkg.name;
    }
    if (typeof pkg.depsCount === 'number' && pkg.depsCount < minDeps) {
      minDeps = pkg.depsCount;
      best.depsCount = pkg.name;
    }
    if (typeof pkg.downloads === 'number' && pkg.downloads > maxDownloads) {
      maxDownloads = pkg.downloads;
      best.downloads = pkg.name;
    }
    if (typeof pkg.lastPublishDays === 'number' && pkg.lastPublishDays < minDaysSincePublish) {
      minDaysSincePublish = pkg.lastPublishDays;
      best.lastPublishDays = pkg.name;
    }
  });

  return best;
}

// ============================================================================
// 3. Network & Caching API Layer
// ============================================================================

const memoryCache = new Map();

/**
 * Unified fetch wrapper with 10s timeout, memory & sessionStorage caching
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function cachedFetch(url, options = {}) {
  // 1. Check in-memory cache
  if (memoryCache.has(url)) {
    return memoryCache.get(url);
  }

  // 2. Check sessionStorage cache
  const storageKey = CONFIG.SESSION_CACHE_PREFIX + url;
  if (typeof sessionStorage !== 'undefined') {
    try {
      const cached = sessionStorage.getItem(storageKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        memoryCache.set(url, parsed);
        return parsed;
      }
    } catch {
      // sessionStorage might be restricted or full
    }
  }

  // 3. Fetch with 10-second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = new Error(`Request failed with status ${res.status}: ${res.statusText}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // Store in both caches
    memoryCache.set(url, data);
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(data));
      } catch {
        // quota exceeded
      }
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after 10s for ${url}`);
    }
    throw err;
  }
}

/**
 * Fetch package metadata from npm registry
 * @param {string} pkgName
 */
async function fetchPackageMetadata(pkgName) {
  // Scoped packages like @types/node must be encoded as @types%2Fnode
  const encodedName = pkgName.startsWith('@')
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : encodeURIComponent(pkgName);
  const url = `https://registry.npmjs.org/${encodedName}`;
  return cachedFetch(url);
}

/**
 * Search packages on npm registry
 * @param {string} query
 */
async function fetchSearch(query) {
  if (!query || query.trim().length === 0) return [];
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=8`;
  const result = await cachedFetch(url);
  return result.objects || [];
}

/**
 * Fetch weekly and historical downloads
 * @param {string} pkgName
 */
async function fetchDownloads(pkgName) {
  const encodedName = pkgName.startsWith('@')
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : encodeURIComponent(pkgName);

  const [weeklyRes, yearlyRes] = await Promise.allSettled([
    cachedFetch(`https://api.npmjs.org/downloads/point/last-week/${encodedName}`),
    cachedFetch(`https://api.npmjs.org/downloads/range/last-year/${encodedName}`),
  ]);

  const weeklyDownloads = weeklyRes.status === 'fulfilled' ? weeklyRes.value?.downloads || 0 : 0;
  const yearlyDownloads = yearlyRes.status === 'fulfilled' ? yearlyRes.value?.downloads || [] : [];

  return {
    weekly: weeklyDownloads,
    history: yearlyDownloads,
  };
}

/**
 * Fetch bundle size from Bundlephobia with jsDelivr fallback
 * @param {string} pkgName
 * @param {string} version
 */
async function fetchBundleSize(pkgName, version) {
  const spec = `${pkgName}@${version}`;
  const bpUrl = `https://bundlephobia.com/api/size?package=${encodeURIComponent(spec)}`;

  try {
    const data = await cachedFetch(bpUrl);
    if (data && (data.size || data.gzip)) {
      return {
        size: data.size,
        gzip: data.gzip,
        source: 'Bundlephobia',
        isEstimated: false,
      };
    }
  } catch (bpErr) {
    console.warn(`Bundlephobia failed for ${spec}, falling back to jsDelivr:`, bpErr.message);
  }

  // Fallback: estimate via jsDelivr package data API
  return fetchJsDelivrEstimatedSize(pkgName, version);
}

/**
 * jsDelivr fallback size calculator
 * @param {string} pkgName
 * @param {string} version
 */
async function fetchJsDelivrEstimatedSize(pkgName, version) {
  const jsdUrl = `https://data.jsdelivr.com/v1/package/npm/${pkgName}@${version}`;

  try {
    const data = await cachedFetch(jsdUrl);
    if (!data || !data.files) {
      throw new Error('No files returned from jsDelivr');
    }

    // Traverse files to sum up script / distribution sizes
    let totalSize = 0;
    function sumFiles(items) {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item.type === 'file' && typeof item.size === 'number') {
          // Include JS, CSS, MJS, CJS
          const name = item.name.toLowerCase();
          if (
            name.endsWith('.js') ||
            name.endsWith('.mjs') ||
            name.endsWith('.cjs') ||
            name.endsWith('.css') ||
            name.endsWith('.wasm')
          ) {
            totalSize += item.size;
          }
        } else if (item.files) {
          sumFiles(item.files);
        }
      }
    }

    sumFiles(data.files);

    if (totalSize > 0) {
      // Estimated gzip compression is typically ~30-35% of uncompressed minified size
      const estimatedGzip = Math.round(totalSize * 0.32);
      return {
        size: totalSize,
        gzip: estimatedGzip,
        source: 'jsDelivr (estimated)',
        isEstimated: true,
      };
    }
  } catch (err) {
    console.warn(`jsDelivr fallback also failed for ${pkgName}@${version}:`, err.message);
  }

  throw new Error(`Could not determine bundle size for ${pkgName}@${version}`);
}

// ============================================================================
// 4. Application State
// ============================================================================

const state = {
  currentPackage: null,
  currentVersion: null,
  packageMeta: null,
  versionData: null,
  sizeData: null,
  downloadsData: null,
  recentSearches: [],
  compareList: [],
  compareData: new Map(),
  isCompareOpen: false,
  theme: 'dark',
  activeInstallPm: 'npm',
  versionsSizeCache: new Map(), // version -> { gzip, size }
};

// ============================================================================
// 5. Canvas Chart Drawing Helpers
// ============================================================================

/**
 * Setup canvas for High-DPI screens
 * @param {HTMLCanvasElement} canvas
 */
function setupHiDpiCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width || canvas.width;
  const height = rect.height || canvas.height;

  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}

/**
 * Draw 12-month weekly downloads trend line chart
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{ day: string, downloads: number }>} history
 * @param {boolean} isDark
 */
function drawDownloadsChart(canvas, history, isDark) {
  if (!canvas) return;
  const { ctx, width, height } = setupHiDpiCanvas(canvas);

  ctx.clearRect(0, 0, width, height);

  if (!history || history.length === 0) {
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.font = '13px ' + CONFIG.fontSans;
    ctx.textAlign = 'center';
    ctx.fillText('No download history available', width / 2, height / 2);
    return;
  }

  // Aggregate daily history into weekly buckets (every 7 days)
  const weeklyData = [];
  let currentSum = 0;
  for (let i = 0; i < history.length; i++) {
    currentSum += history[i].downloads || 0;
    if ((i + 1) % 7 === 0 || i === history.length - 1) {
      weeklyData.push({
        date: history[i].day,
        downloads: currentSum,
      });
      currentSum = 0;
    }
  }

  const padding = { top: 25, right: 30, bottom: 40, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...weeklyData.map((d) => d.downloads), 10);
  const minVal = 0;

  // Grid lines
  const gridLines = 4;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartH / gridLines) * i;
    const val = maxVal - (maxVal / gridLines) * i;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(formatNumber(val), padding.left - 10, y + 4);
  }

  // Compute points
  const points = weeklyData.map((d, idx) => {
    const x = padding.left + (chartW / (weeklyData.length - 1 || 1)) * idx;
    const y = padding.top + chartH - (d.downloads / maxVal) * chartH;
    return { x, y, data: d };
  });

  // Flat area fill (zero gradients)
  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + chartH);
  points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(37, 99, 235, 0.05)';
  ctx.fill();

  // Draw crisp stroke line
  ctx.beginPath();
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  points.forEach((pt, idx) => {
    if (idx === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();

  // Draw date labels on X axis
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  const labelInterval = Math.ceil(weeklyData.length / 5);
  points.forEach((pt, idx) => {
    if (idx % labelInterval === 0 || idx === points.length - 1) {
      const parts = pt.data.date.split('-');
      const label = parts.length >= 2 ? `${parts[1]}/${parts[0].slice(2)}` : pt.data.date;
      ctx.fillText(label, pt.x, height - padding.bottom + 18);
    }
  });

  // Attach interactive hover listener to canvas
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    let closest = null;
    let minDiff = Infinity;

    points.forEach((pt) => {
      const diff = Math.abs(pt.x - mouseX);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    });

    const tooltip = document.getElementById('downloads-chart-tooltip');
    if (closest && minDiff < 40 && tooltip) {
      tooltip.classList.remove('hidden');
      tooltip.style.left = `${closest.x}px`;
      tooltip.style.top = `${closest.y}px`;
      tooltip.innerHTML = `<strong>${formatNumber(closest.data.downloads)} dl</strong><br><span style="color:var(--text-muted)">Week of ${closest.data.date}</span>`;
    } else if (tooltip) {
      tooltip.classList.add('hidden');
    }
  };

  canvas.onmouseleave = () => {
    const tooltip = document.getElementById('downloads-chart-tooltip');
    if (tooltip) tooltip.classList.add('hidden');
  };
}

/**
 * Draw Version Bloat History Chart (last 15 releases gzipped size)
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{ version: string, gzip: number|null }>} versionsData
 * @param {boolean} isDark
 */
function drawVersionsChart(canvas, versionsData, isDark) {
  if (!canvas) return;
  const { ctx, width, height } = setupHiDpiCanvas(canvas);

  ctx.clearRect(0, 0, width, height);

  const valid = (versionsData || []).filter((v) => typeof v.gzip === 'number' && v.gzip > 0);

  if (valid.length === 0) {
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.font = '13px ' + CONFIG.fontSans;
    ctx.textAlign = 'center';
    ctx.fillText('Loading version bundle sizes...', width / 2, height / 2);
    return;
  }

  const padding = { top: 25, right: 30, bottom: 45, left: 65 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...valid.map((v) => v.gzip), 1024);

  // Grid lines
  const gridLines = 4;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartH / gridLines) * i;
    const val = maxVal - (maxVal / gridLines) * i;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(formatBytes(val), padding.left - 10, y + 4);
  }

  // Points
  const points = valid.map((item, idx) => {
    const x = padding.left + (chartW / (valid.length - 1 || 1)) * idx;
    const y = padding.top + chartH - (item.gzip / maxVal) * chartH;
    return { x, y, data: item };
  });

  // Flat area fill (zero gradients)
  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + chartH);
  points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(5, 150, 105, 0.05)';
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#059669';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  points.forEach((pt, idx) => {
    if (idx === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();

  // Point circles
  points.forEach((pt) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // Version labels
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.font = '10px JetBrains Mono, monospace';

  const labelStep = Math.ceil(valid.length / 8);
  points.forEach((pt, idx) => {
    if (idx % labelStep === 0 || idx === points.length - 1) {
      ctx.fillText(pt.data.version, pt.x, height - padding.bottom + 18);
    }
  });

  // Hover listener
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    let closest = null;
    let minDiff = Infinity;

    points.forEach((pt) => {
      const diff = Math.abs(pt.x - mouseX);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    });

    const tooltip = document.getElementById('versions-chart-tooltip');
    if (closest && minDiff < 30 && tooltip) {
      tooltip.classList.remove('hidden');
      tooltip.style.left = `${closest.x}px`;
      tooltip.style.top = `${closest.y}px`;
      tooltip.innerHTML = `<strong>v${closest.data.version}</strong>: ${formatBytes(closest.data.gzip)} gzip`;
    } else if (tooltip) {
      tooltip.classList.add('hidden');
    }
  };

  canvas.onmouseleave = () => {
    const tooltip = document.getElementById('versions-chart-tooltip');
    if (tooltip) tooltip.classList.add('hidden');
  };
}

/**
 * Draw Compare Mode Bar Chart (gzipped size across compared packages)
 * @param {HTMLCanvasElement} canvas
 * @param {Array<object>} packages
 * @param {boolean} isDark
 */
function drawCompareBarChart(canvas, packages, isDark) {
  if (!canvas) return;
  const { ctx, width, height } = setupHiDpiCanvas(canvas);

  ctx.clearRect(0, 0, width, height);

  if (!packages || packages.length === 0) {
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No packages to compare', width / 2, height / 2);
    return;
  }

  const validPkgs = packages.filter((p) => p && typeof p.gzip === 'number' && p.gzip > 0);
  if (validPkgs.length === 0) {
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Bundle size data loading or unavailable', width / 2, height / 2);
    return;
  }

  const padding = { top: 20, right: 25, bottom: 35, left: 110 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...validPkgs.map((p) => p.gzip), 1024);
  const barHeight = Math.min(26, (chartH / validPkgs.length) * 0.65);
  const barSpacing = chartH / validPkgs.length;

  // Find lowest gzip for highlight
  const minGzip = Math.min(...validPkgs.map((p) => p.gzip));

  validPkgs.forEach((pkg, idx) => {
    const y = padding.top + idx * barSpacing + (barSpacing - barHeight) / 2;
    const barW = Math.max(4, (pkg.gzip / maxVal) * chartW);
    const isBest = pkg.gzip === minGzip;

    // Label
    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    const truncatedName = pkg.name.length > 12 ? pkg.name.slice(0, 11) + '…' : pkg.name;
    ctx.fillText(truncatedName, padding.left - 10, y + barHeight / 2 + 4);

    // Bar background track
    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)';
    ctx.beginPath();
    ctx.roundRect(padding.left, y, chartW, barHeight, 4);
    ctx.fill();

    // Bar fill
    ctx.fillStyle = isBest
      ? (isDark ? '#10b981' : '#059669')
      : (isDark ? '#6366f1' : '#4f46e5');
    ctx.beginPath();
    ctx.roundRect(padding.left, y, barW, barHeight, 4);
    ctx.fill();

    // Value text inside or beside bar
    ctx.fillStyle = barW > 70 ? '#ffffff' : (isDark ? '#cbd5e1' : '#334155');
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = barW > 70 ? 'right' : 'left';
    const textX = barW > 70 ? padding.left + barW - 8 : padding.left + barW + 8;
    ctx.fillText(formatBytes(pkg.gzip), textX, y + barHeight / 2 + 4);
  });
}

// ============================================================================
// 6. DOM Rendering Functions
// ============================================================================

/**
 * Render package overview card
 * @param {object} meta
 * @param {object} versionObj
 */
function renderOverview(meta, versionObj) {
  const isDeprecated = Boolean(versionObj.deprecated || meta.deprecated);
  const deprecationBanner = document.getElementById('deprecation-banner');
  const deprecationReason = document.getElementById('deprecation-reason');

  if (isDeprecated) {
    deprecationBanner.classList.remove('hidden');
    deprecationReason.textContent = versionObj.deprecated || meta.deprecated || 'Package is marked as deprecated on npm.';
  } else {
    deprecationBanner.classList.add('hidden');
  }

  // Name & versions
  document.getElementById('pkg-name').textContent = meta.name;
  document.getElementById('pkg-description').textContent =
    versionObj.description || meta.description || 'No description provided by author.';

  // Populate version dropdown
  const versionSelect = document.getElementById('version-select');
  versionSelect.innerHTML = '';
  const versionsList = Object.keys(meta.versions || {}).reverse();

  versionsList.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = `v${v}${v === meta['dist-tags']?.latest ? ' (latest)' : ''}`;
    if (v === versionObj.version) {
      opt.selected = true;
    }
    versionSelect.appendChild(opt);
  });

  // External links
  const npmLink = document.getElementById('npm-link');
  npmLink.href = `https://www.npmjs.com/package/${meta.name}`;

  const repoLink = document.getElementById('repo-link');
  let repoUrl = null;
  if (typeof versionObj.repository === 'string') {
    repoUrl = versionObj.repository;
  } else if (versionObj.repository?.url) {
    repoUrl = versionObj.repository.url;
  }
  if (repoUrl) {
    repoUrl = repoUrl
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '');
    repoLink.href = repoUrl;
    repoLink.classList.remove('hidden');
  } else {
    repoLink.classList.add('hidden');
  }

  const homepageLink = document.getElementById('homepage-link');
  if (versionObj.homepage) {
    homepageLink.href = versionObj.homepage;
    homepageLink.classList.remove('hidden');
  } else {
    homepageLink.classList.add('hidden');
  }

  // Metadata items
  document.getElementById('pkg-license').textContent = versionObj.license || meta.license || 'Proprietary';

  let authorText = 'Unknown';
  if (typeof versionObj.author === 'string') authorText = versionObj.author;
  else if (versionObj.author?.name) authorText = versionObj.author.name;
  else if (meta.author?.name) authorText = meta.author.name;
  document.getElementById('pkg-author').textContent = authorText;

  // Last published
  let publishStr = '--';
  if (meta.time && meta.time[versionObj.version]) {
    const pubDate = new Date(meta.time[versionObj.version]);
    publishStr = pubDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } else if (meta.time?.modified) {
    const pubDate = new Date(meta.time.modified);
    publishStr = pubDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  document.getElementById('pkg-published').textContent = publishStr;

  document.getElementById('pkg-versions-count').textContent = versionsList.length;

  const maintainersCount = Array.isArray(meta.maintainers) ? meta.maintainers.length : 1;
  document.getElementById('pkg-maintainers').textContent = `${maintainersCount} maintainer${maintainersCount > 1 ? 's' : ''}`;

  // Update quick sidebar links
  document.getElementById('unpkg-link').href = `https://unpkg.com/browse/${meta.name}@${versionObj.version}/`;
  document.getElementById('jsdelivr-link').href = `https://cdn.jsdelivr.net/npm/${meta.name}@${versionObj.version}/`;

  // Hide skeleton & reveal overview
  document.getElementById('overview-skeleton').classList.add('hidden');
  document.getElementById('overview-content').classList.remove('hidden');
}

/**
 * Render size metrics
 * @param {object|null} sizeData
 * @param {boolean} [loading]
 * @param {Error|null} [error]
 */
function renderSizes(sizeData, loading = false, error = null) {
  const skeleton = document.getElementById('size-skeleton');
  const grid = document.getElementById('size-cards-grid');
  const errorNotice = document.getElementById('size-error-notice');
  const retryBtn = document.getElementById('size-retry-btn');
  const sourceBadge = document.getElementById('size-source-badge');

  if (loading) {
    skeleton.classList.remove('hidden');
    grid.classList.add('hidden');
    errorNotice.classList.add('hidden');
    retryBtn.classList.add('hidden');
    return;
  }

  skeleton.classList.add('hidden');

  if (error || !sizeData) {
    grid.classList.add('hidden');
    errorNotice.classList.remove('hidden');
    retryBtn.classList.remove('hidden');
    sourceBadge.textContent = 'Unavailable';
    return;
  }

  errorNotice.classList.add('hidden');
  retryBtn.classList.add('hidden');
  grid.classList.remove('hidden');

  sourceBadge.textContent = sizeData.source || 'via Bundlephobia';

  // Format minified & gzipped
  document.getElementById('size-minified').textContent = formatBytes(sizeData.size);
  document.getElementById('size-gzipped').textContent = formatBytes(sizeData.gzip);

  // Compression ratio
  if (sizeData.size && sizeData.gzip) {
    const ratio = Math.round((1 - sizeData.gzip / sizeData.size) * 100);
    const ratioPill = document.getElementById('gzip-compression-ratio');
    ratioPill.textContent = `${ratio}% compressed`;
    ratioPill.classList.remove('hidden');
  } else {
    document.getElementById('gzip-compression-ratio').classList.add('hidden');
  }

  // Estimated download speeds
  const speed3G = estimateDownloadTime(sizeData.gzip || sizeData.size, CONFIG.SPEED_SLOW_3G_BPS);
  const speed4G = estimateDownloadTime(sizeData.gzip || sizeData.size, CONFIG.SPEED_4G_BPS);

  document.getElementById('speed-3g').textContent = speed3G;
  document.getElementById('speed-4g').textContent = speed4G;
}

/**
 * Render health indicators
 * @param {object} health
 */
function renderHealth(health) {
  // 1. TypeScript
  const statusTypes = document.getElementById('status-types');
  if (health.hasTypes) {
    statusTypes.textContent = 'Built-in typings';
    statusTypes.className = 'health-status status-good';
  } else {
    statusTypes.textContent = 'No built-in types (check @types)';
    statusTypes.className = 'health-status status-warn';
  }

  // 2. ESM
  const statusEsm = document.getElementById('status-esm');
  if (health.isEsm) {
    statusEsm.textContent = 'ES Module ready';
    statusEsm.className = 'health-status status-good';
  } else {
    statusEsm.textContent = 'CommonJS format';
    statusEsm.className = 'health-status';
  }

  // 3. Tree Shakeable
  const statusTreeshake = document.getElementById('status-treeshake');
  if (health.isTreeShakeable) {
    statusTreeshake.textContent = 'Tree shakeable (sideEffects: false)';
    statusTreeshake.className = 'health-status status-good';
  } else {
    statusTreeshake.textContent = 'Side effects not declared';
    statusTreeshake.className = 'health-status';
  }

  // 4. Maintenance
  const statusMaint = document.getElementById('status-maintenance');
  if (health.isOutdated) {
    statusMaint.textContent = `Inactive (> 2 years since release)`;
    statusMaint.className = 'health-status status-warn';
  } else {
    statusMaint.textContent = `Active (${health.daysSincePublish} days ago)`;
    statusMaint.className = 'health-status status-good';
  }

  // 5. Maintainers
  const statusMaintainers = document.getElementById('status-maintainers');
  statusMaintainers.textContent = `${health.maintainersCount} active maintainer${health.maintainersCount > 1 ? 's' : ''}`;
  statusMaintainers.className = health.maintainersCount > 1 ? 'health-status status-good' : 'health-status';
}

/**
 * Render Dependencies Explorer Tree
 * @param {object} versionObj
 */
function renderDependencies(versionObj) {
  const deps = versionObj.dependencies || {};
  const peerDeps = versionObj.peerDependencies || {};
  const depKeys = Object.keys(deps);
  const peerKeys = Object.keys(peerDeps);

  const countBadge = document.getElementById('deps-count-badge');
  countBadge.textContent = `${depKeys.length} direct dependenc${depKeys.length === 1 ? 'y' : 'ies'}`;

  const warningBadge = document.getElementById('deps-warning-badge');
  if (depKeys.length > 10) {
    warningBadge.classList.remove('hidden');
    const span = warningBadge.querySelector('span');
    if (span) span.textContent = `Heavy dependency footprint (${depKeys.length} dependencies)`;
    else warningBadge.textContent = `Heavy dependency footprint (${depKeys.length} dependencies)`;
  } else {
    warningBadge.classList.add('hidden');
  }

  const treeContainer = document.getElementById('deps-tree-container');
  treeContainer.innerHTML = '';

  if (depKeys.length === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'empty-state-notice';
    emptyNotice.textContent = 'Zero direct dependencies (self-contained package)';
    treeContainer.appendChild(emptyNotice);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'tree-list';

    depKeys.forEach((depName) => {
      const depVer = deps[depName];
      const li = createTreeNode(depName, depVer, 1);
      ul.appendChild(li);
    });

    treeContainer.appendChild(ul);
  }

  // Peer dependencies
  const peerWrap = document.getElementById('peer-deps-wrap');
  const peerList = document.getElementById('peer-deps-list');
  peerList.innerHTML = '';

  if (peerKeys.length > 0) {
    peerWrap.classList.remove('hidden');
    peerKeys.forEach((peer) => {
      const span = document.createElement('div');
      span.className = 'peer-dep-item';
      span.innerHTML = `<strong>${escapeHtml(peer)}</strong><span style="color:var(--text-muted)">${escapeHtml(peerDeps[peer])}</span>`;
      peerList.appendChild(span);
    });
  } else {
    peerWrap.classList.add('hidden');
  }
}

/**
 * Create tree node for dependencies explorer with lazy expansion
 * @param {string} name
 * @param {string} versionSpec
 * @param {number} depth
 */
function createTreeNode(name, versionSpec, depth) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-node-content';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');

  const caret = document.createElement('span');
  caret.className = 'tree-toggle-caret';
  caret.innerHTML = depth < CONFIG.MAX_TREE_DEPTH
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polyline points="9 18 15 12 9 6"></polyline></svg>'
    : '<span style="display:inline-block;width:4px;height:4px;border-radius:50%;background:currentColor;"></span>';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tree-node-name';
  nameSpan.textContent = name;

  const verSpan = document.createElement('span');
  verSpan.className = 'tree-node-version';
  verSpan.textContent = versionSpec;

  const actions = document.createElement('div');
  actions.className = 'tree-node-actions';

  const inspectBtn = document.createElement('button');
  inspectBtn.className = 'tree-inspect-btn';
  inspectBtn.textContent = 'Inspect';
  inspectBtn.title = `Explore ${name}`;
  inspectBtn.onclick = (e) => {
    e.stopPropagation();
    loadPackage(name);
  };
  actions.appendChild(inspectBtn);

  row.appendChild(caret);
  row.appendChild(nameSpan);
  row.appendChild(verSpan);
  row.appendChild(actions);
  li.appendChild(row);

  let childrenContainer = null;
  let isExpanded = false;
  let isLoading = false;

  async function toggle() {
    if (depth >= CONFIG.MAX_TREE_DEPTH) {
      showToast(`Maximum depth of ${CONFIG.MAX_TREE_DEPTH} levels reached`);
      return;
    }

    if (isExpanded) {
      isExpanded = false;
      caret.classList.remove('open');
      if (childrenContainer) childrenContainer.classList.add('hidden');
      return;
    }

    isExpanded = true;
    caret.classList.add('open');

    if (childrenContainer) {
      childrenContainer.classList.remove('hidden');
      return;
    }

    // Lazy load sub-dependencies
    if (isLoading) return;
    isLoading = true;

    const spinner = document.createElement('div');
    spinner.className = 'tree-spinner';
    row.appendChild(spinner);

    try {
      const meta = await fetchPackageMetadata(name);
      const latestVer = meta['dist-tags']?.latest || Object.keys(meta.versions || {}).pop();
      const verObj = meta.versions?.[latestVer] || {};
      const subDeps = verObj.dependencies || {};
      const subKeys = Object.keys(subDeps);

      childrenContainer = document.createElement('ul');
      childrenContainer.className = 'tree-children';

      if (subKeys.length === 0) {
        const emptyLi = document.createElement('li');
        emptyLi.className = 'tree-node';
        emptyLi.innerHTML = `<span style="font-size:0.775rem; color:var(--text-muted); padding-left:1rem;">No sub-dependencies</span>`;
        childrenContainer.appendChild(emptyLi);
      } else {
        subKeys.forEach((subName) => {
          const subLi = createTreeNode(subName, subDeps[subName], depth + 1);
          childrenContainer.appendChild(subLi);
        });
      }

      li.appendChild(childrenContainer);
    } catch (err) {
      const errLi = document.createElement('li');
      errLi.className = 'tree-node';
      errLi.innerHTML = `<span style="font-size:0.775rem; color:var(--danger); padding-left:1rem;">Failed to load dependencies: ${escapeHtml(err.message)}</span>`;
      childrenContainer = document.createElement('ul');
      childrenContainer.className = 'tree-children';
      childrenContainer.appendChild(errLi);
      li.appendChild(childrenContainer);
    } finally {
      isLoading = false;
      spinner.remove();
    }
  }

  row.onclick = toggle;
  row.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  return li;
}

/**
 * Render Similar Alternatives Section
 * @param {Array<string>} keywords
 * @param {string} currentPkg
 */
async function renderAlternatives(keywords, currentPkg) {
  const container = document.getElementById('alternatives-grid');
  const subtext = document.getElementById('alternatives-subtext');
  container.innerHTML = '<div class="empty-state-notice">Searching for similar packages...</div>';

  let searchTerms = currentPkg;
  if (Array.isArray(keywords) && keywords.length > 0) {
    searchTerms = keywords.slice(0, 2).join(' ');
  }

  subtext.textContent = `Packages discovered for: "${searchTerms}"`;

  try {
    const results = await fetchSearch(searchTerms);
    const filtered = results
      .map((r) => r.package)
      .filter((p) => p && p.name !== currentPkg)
      .slice(0, 4);

    container.innerHTML = '';

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state-notice">No similar packages found.</div>';
      return;
    }

    for (const alt of filtered) {
      const card = document.createElement('div');
      card.className = 'alt-card';

      const header = document.createElement('div');
      header.className = 'alt-card-header';
      header.innerHTML = `
        <span class="alt-name" data-pkg="${escapeHtml(alt.name)}">${escapeHtml(alt.name)}</span>
        <span style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono)">v${escapeHtml(alt.version)}</span>
      `;

      const desc = document.createElement('p');
      desc.className = 'alt-desc';
      desc.textContent = alt.description || 'No description';

      const metrics = document.createElement('div');
      metrics.className = 'alt-metrics';
      metrics.innerHTML = `
        <span class="font-mono alt-size-stat" data-pkg="${escapeHtml(alt.name)}">Size: …</span>
        <span class="font-mono">Weekly dl: …</span>
      `;

      const actions = document.createElement('div');
      actions.className = 'alt-actions';
      actions.innerHTML = `
        <button type="button" class="alt-btn" data-action="explore" data-pkg="${escapeHtml(alt.name)}">Inspect</button>
        <button type="button" class="alt-btn" data-action="compare" data-pkg="${escapeHtml(alt.name)}">+ Compare</button>
      `;

      card.appendChild(header);
      card.appendChild(desc);
      card.appendChild(metrics);
      card.appendChild(actions);
      container.appendChild(card);

      // Lazily populate size & downloads for alternative
      loadAltMetrics(alt.name, alt.version, metrics);
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state-notice">Could not load alternatives: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Load size and downloads asynchronously for an alternative card
 */
async function loadAltMetrics(name, version, metricsEl) {
  try {
    const [sizeRes, dlRes] = await Promise.allSettled([
      fetchBundleSize(name, version),
      fetchDownloads(name),
    ]);

    const sizeStr = sizeRes.status === 'fulfilled' && sizeRes.value ? formatBytes(sizeRes.value.gzip) : 'N/A';
    const dlStr = dlRes.status === 'fulfilled' && dlRes.value ? formatNumber(dlRes.value.weekly) : 'N/A';

    metricsEl.innerHTML = `
      <span class="font-mono" title="Minified + Gzipped size">${sizeStr} gzip</span>
      <span class="font-mono" title="Weekly downloads">${dlStr} / wk</span>
    `;
  } catch {
    // leave default
  }
}

/**
 * Render install snippet based on package name and active manager
 */
function renderInstallSnippet() {
  const pkg = state.currentPackage;
  if (!pkg) return;

  const codeEl = document.getElementById('install-command-text');
  const pm = state.activeInstallPm;

  let cmd = `npm i ${pkg}`;
  if (pm === 'pnpm') cmd = `pnpm add ${pkg}`;
  else if (pm === 'yarn') cmd = `yarn add ${pkg}`;
  else if (pm === 'bun') cmd = `bun add ${pkg}`;

  codeEl.textContent = cmd;
}

/**
 * Render recent searches as chips
 */
function renderRecentSearches() {
  const recents = state.recentSearches || [];
  const landingBox = document.getElementById('recent-searches-box');
  const landingList = document.getElementById('recent-chips-list');
  const subbarList = document.getElementById('recent-chips-subbar');

  if (landingList) landingList.innerHTML = '';
  if (subbarList) subbarList.innerHTML = '';

  if (recents.length === 0) {
    if (landingBox) landingBox.classList.add('hidden');
    return;
  }

  if (landingBox) landingBox.classList.remove('hidden');

  recents.forEach((item) => {
    // For landing
    if (landingList) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn';
      btn.dataset.pkg = item;
      btn.textContent = item;
      landingList.appendChild(btn);
    }

    // For subbar
    if (subbarList) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn';
      btn.dataset.pkg = item;
      btn.textContent = item;
      subbarList.appendChild(btn);
    }
  });
}

/**
 * Add package name to recent searches (persisting in localStorage)
 * @param {string} name
 */
function addRecentSearch(name) {
  if (!name) return;
  state.recentSearches = [name, ...state.recentSearches.filter((n) => n !== name)].slice(0, 8);
  try {
    localStorage.setItem(CONFIG.STORAGE_KEYS.RECENT, JSON.stringify(state.recentSearches));
  } catch {
    // ignore
  }
  renderRecentSearches();
}

/**
 * Lazily load size for the last 15 versions to draw bloat chart
 * @param {string} pkgName
 * @param {Array<string>} versions
 */
async function loadVersionHistorySizes(pkgName, versions) {
  const last15 = versions.slice(-CONFIG.MAX_VERSION_HISTORY);
  const statusEl = document.getElementById('versions-progress-text');
  const canvas = document.getElementById('versions-chart');
  const isDark = state.theme === 'dark';

  const results = [];
  let loadedCount = 0;

  for (const v of last15) {
    const cacheKey = `${pkgName}@${v}`;
    if (state.versionsSizeCache.has(cacheKey)) {
      results.push({ version: v, gzip: state.versionsSizeCache.get(cacheKey).gzip });
      loadedCount++;
    } else {
      try {
        if (statusEl) statusEl.textContent = `Loading sizes (${loadedCount}/${last15.length})...`;
        const sz = await fetchBundleSize(pkgName, v);
        state.versionsSizeCache.set(cacheKey, sz);
        results.push({ version: v, gzip: sz.gzip });
      } catch {
        results.push({ version: v, gzip: null });
      }
      loadedCount++;
    }
    // Update chart iteratively
    drawVersionsChart(canvas, results, isDark);

    // Stagger slightly (100ms) to respect Bundlephobia/jsDelivr rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (statusEl) statusEl.textContent = `Last ${results.filter((r) => r.gzip).length} releases analyzed`;
}

// ============================================================================
// 7. Compare Mode Logic & Rendering
// ============================================================================

/**
 * Add package to compare list
 * @param {string} name
 */
async function addToCompare(name) {
  if (!name) return;
  if (state.compareList.includes(name)) {
    showToast(`"${name}" is already in compare list`);
    return;
  }
  if (state.compareList.length >= CONFIG.MAX_COMPARE_ITEMS) {
    showToast(`Maximum ${CONFIG.MAX_COMPARE_ITEMS} packages can be compared at once`);
    return;
  }

  state.compareList.push(name);
  updateCompareBadge();
  syncUrlQuery();

  showToast(`Added "${name}" to compare list`);

  if (state.isCompareOpen) {
    await fetchAndRenderCompare();
  }
}

/**
 * Remove package from compare list
 * @param {string} name
 */
function removeFromCompare(name) {
  state.compareList = state.compareList.filter((n) => n !== name);
  updateCompareBadge();
  syncUrlQuery();
  fetchAndRenderCompare();
}

/**
 * Update compare badge counter
 */
function updateCompareBadge() {
  const badge = document.getElementById('compare-badge');
  const addCompareBtn = document.getElementById('add-compare-btn');

  if (badge) {
    if (state.compareList.length > 0) {
      badge.textContent = state.compareList.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (addCompareBtn && state.currentPackage) {
    const isAdded = state.compareList.includes(state.currentPackage);
    addCompareBtn.classList.toggle('active', isAdded);
    const textSpan = document.getElementById('add-compare-text');
    if (textSpan) textSpan.textContent = isAdded ? 'In Compare' : 'Compare';
  }
}

/**
 * Toggle Compare Modal
 * @param {boolean} [open]
 */
function toggleCompareModal(open) {
  const modal = document.getElementById('compare-modal');
  state.isCompareOpen = typeof open === 'boolean' ? open : !state.isCompareOpen;

  if (state.isCompareOpen) {
    modal.classList.remove('hidden');
    fetchAndRenderCompare();
  } else {
    modal.classList.add('hidden');
  }
}

/**
 * Fetch data for all compared packages and render table + bar chart
 */
async function fetchAndRenderCompare() {
  const theadRow = document.getElementById('compare-thead-row');
  const tbody = document.getElementById('compare-tbody');
  const chartCanvas = document.getElementById('compare-bar-chart');
  const isDark = state.theme === 'dark';

  if (state.compareList.length === 0) {
    theadRow.innerHTML = '<th class="metric-col">Metric</th><th>No packages selected</th>';
    tbody.innerHTML = `<tr><td colspan="2" class="empty-state-notice">Add packages using the input above or "+ Compare" buttons.</td></tr>`;
    drawCompareBarChart(chartCanvas, [], isDark);
    return;
  }

  // Load missing data for compare list
  const comparePackages = [];

  for (const pkgName of state.compareList) {
    let item = state.compareData.get(pkgName);
    if (!item) {
      try {
        const [meta, dl] = await Promise.all([
          fetchPackageMetadata(pkgName),
          fetchDownloads(pkgName),
        ]);
        const ver = meta['dist-tags']?.latest || Object.keys(meta.versions || {}).pop();
        const verObj = meta.versions?.[ver] || {};

        let sz = null;
        try {
          sz = await fetchBundleSize(pkgName, ver);
        } catch {
          sz = { size: null, gzip: null };
        }

        const health = evaluateHealth(meta, verObj);
        const depsCount = Object.keys(verObj.dependencies || {}).length;

        item = {
          name: pkgName,
          version: ver,
          size: sz?.size || null,
          gzip: sz?.gzip || null,
          depsCount,
          downloads: dl.weekly || 0,
          license: verObj.license || meta.license || 'Unknown',
          lastPublishDays: health.daysSincePublish,
          lastPublishDate: health.lastPublishDate,
          hasTypes: health.hasTypes,
          isEsm: health.isEsm,
          isTreeShakeable: health.isTreeShakeable,
        };

        state.compareData.set(pkgName, item);
      } catch (err) {
        console.error(`Error loading compare item ${pkgName}:`, err);
        item = {
          name: pkgName,
          error: true,
        };
      }
    }
    comparePackages.push(item);
  }

  // Calculate best values for green highlighting
  const best = findBestValues(comparePackages.filter((p) => !p.error));

  // Build Table Header
  theadRow.innerHTML = '<th class="metric-col">Metric</th>';
  comparePackages.forEach((pkg) => {
    const th = document.createElement('th');
    th.className = 'pkg-col';
    th.innerHTML = `
      <div class="compare-pkg-header">
        <span>${escapeHtml(pkg.name)} <span style="font-weight:400; font-size:0.8rem; color:var(--text-muted)">v${escapeHtml(pkg.version || '')}</span></span>
        <button type="button" class="remove-compare-btn" data-pkg="${escapeHtml(pkg.name)}" title="Remove">&times;</button>
      </div>
    `;
    theadRow.appendChild(th);
  });

  // Metric Rows definitions
  const rows = [
    {
      label: 'Minified Size',
      key: 'size',
      formatter: (pkg) => formatBytes(pkg.size),
      isBest: (pkg) => best.size === pkg.name,
    },
    {
      label: 'Gzipped Size',
      key: 'gzip',
      formatter: (pkg) => formatBytes(pkg.gzip),
      isBest: (pkg) => best.gzip === pkg.name,
    },
    {
      label: 'Dependencies',
      key: 'depsCount',
      formatter: (pkg) => `${pkg.depsCount} direct`,
      isBest: (pkg) => best.depsCount === pkg.name,
    },
    {
      label: 'Weekly Downloads',
      key: 'downloads',
      formatter: (pkg) => `${formatNumber(pkg.downloads)}/wk`,
      isBest: (pkg) => best.downloads === pkg.name,
    },
    {
      label: 'License',
      key: 'license',
      formatter: (pkg) => pkg.license,
      isBest: () => false,
    },
    {
      label: 'Last Published',
      key: 'lastPublishDays',
      formatter: (pkg) => `${pkg.lastPublishDays}d ago`,
      isBest: (pkg) => best.lastPublishDays === pkg.name,
    },
    {
      label: 'TypeScript',
      key: 'hasTypes',
      formatter: (pkg) => (pkg.hasTypes ? 'Built-in' : 'None'),
      isBest: (pkg) => pkg.hasTypes,
    },
    {
      label: 'ESM Support',
      key: 'isEsm',
      formatter: (pkg) => (pkg.isEsm ? 'ESM' : 'CommonJS'),
      isBest: (pkg) => pkg.isEsm,
    },
    {
      label: 'Tree-Shakeable',
      key: 'isTreeShakeable',
      formatter: (pkg) => (pkg.isTreeShakeable ? 'Yes' : 'No'),
      isBest: (pkg) => pkg.isTreeShakeable,
    },
  ];

  tbody.innerHTML = '';
  rows.forEach((rowDef) => {
    const tr = document.createElement('tr');
    const labelTd = document.createElement('td');
    labelTd.className = 'metric-col';
    labelTd.textContent = rowDef.label;
    tr.appendChild(labelTd);

    comparePackages.forEach((pkg) => {
      const td = document.createElement('td');
      if (pkg.error) {
        td.textContent = 'Error loading';
        td.style.color = 'var(--danger)';
      } else {
        td.textContent = rowDef.formatter(pkg);
        if (rowDef.isBest(pkg)) {
          td.classList.add('best-value-cell');
        }
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  // Draw comparison canvas bar chart
  drawCompareBarChart(chartCanvas, comparePackages, isDark);
}

// ============================================================================
// 8. Main Application Controller & Loading Flow
// ============================================================================

/**
 * Load package by name and optional version
 * @param {string} fullSpec
 */
async function loadPackage(fullSpec) {
  const { name, version: requestedVersion } = parsePackageSpec(fullSpec);
  if (!name) return;

  state.currentPackage = name;
  state.currentVersion = requestedVersion;

  // UI state transitions
  const landingView = document.getElementById('landing-view');
  const packageView = document.getElementById('package-view');
  const errorBanner = document.getElementById('package-error-banner');

  landingView.classList.add('hidden');
  packageView.classList.remove('hidden');
  errorBanner.classList.add('hidden');

  // Show skeletons
  document.getElementById('overview-skeleton').classList.remove('hidden');
  document.getElementById('overview-content').classList.add('hidden');
  renderSizes(null, true);

  // Sync inputs
  document.getElementById('search-input').value = name;
  const landingInput = document.getElementById('landing-search-input');
  if (landingInput) landingInput.value = name;

  // Add to recent searches & sync URL
  addRecentSearch(name);
  updateCompareBadge();
  syncUrlQuery();

  try {
    // 1. Fetch package metadata
    const meta = await fetchPackageMetadata(name);
    state.packageMeta = meta;

    // Determine target version
    const availableVersions = Object.keys(meta.versions || {});
    let targetVersion = requestedVersion;
    if (!targetVersion || !meta.versions?.[targetVersion]) {
      targetVersion = meta['dist-tags']?.latest || availableVersions[availableVersions.length - 1];
    }
    state.currentVersion = targetVersion;
    state.versionData = meta.versions?.[targetVersion] || {};

    // 2. Render Overview & Health
    renderOverview(meta, state.versionData);
    const health = evaluateHealth(meta, state.versionData);
    renderHealth(health);

    // 3. Render Dependencies
    renderDependencies(state.versionData);

    // 4. Render Install Snippet
    renderInstallSnippet();

    // 5. Fetch Bundle Size (Isolated Promise)
    fetchBundleSize(name, targetVersion)
      .then((sz) => {
        state.sizeData = sz;
        renderSizes(sz, false, null);
      })
      .catch((szErr) => {
        state.sizeData = null;
        renderSizes(null, false, szErr);
      });

    // 6. Fetch Downloads & Draw Chart (Isolated Promise)
    fetchDownloads(name)
      .then((dl) => {
        state.downloadsData = dl;
        const currentDlEl = document.getElementById('current-weekly-dl');
        if (currentDlEl) currentDlEl.textContent = `${formatNumber(dl.weekly)} / week`;
        const dlCanvas = document.getElementById('downloads-chart');
        drawDownloadsChart(dlCanvas, dl.history, state.theme === 'dark');
      })
      .catch((dlErr) => {
        console.warn('Failed to load downloads:', dlErr);
      });

    // 7. Load Version Bloat Chart Lazily
    loadVersionHistorySizes(name, availableVersions);

    // 8. Render Alternatives based on keywords
    renderAlternatives(state.versionData.keywords || meta.keywords || [], name);
  } catch (err) {
    console.error(`Failed to load package ${name}:`, err);
    errorBanner.classList.remove('hidden');
    document.getElementById('error-title').textContent = `Failed to load "${name}"`;
    document.getElementById('error-message').textContent =
      err.message || 'Could not fetch package from the npm registry.';
    document.getElementById('overview-skeleton').classList.add('hidden');
    renderSizes(null, false, err);
  }
}

/**
 * Handle switching version via dropdown
 * @param {string} newVersion
 */
async function switchVersion(newVersion) {
  if (!state.packageMeta || !state.packageMeta.versions?.[newVersion]) return;

  state.currentVersion = newVersion;
  state.versionData = state.packageMeta.versions[newVersion];

  // Update Overview & Health
  renderOverview(state.packageMeta, state.versionData);
  const health = evaluateHealth(state.packageMeta, state.versionData);
  renderHealth(health);

  // Update Dependencies
  renderDependencies(state.versionData);

  // Update sizes for new version
  renderSizes(null, true);
  try {
    const sz = await fetchBundleSize(state.currentPackage, newVersion);
    state.sizeData = sz;
    renderSizes(sz, false, null);
  } catch (err) {
    renderSizes(null, false, err);
  }

  syncUrlQuery();
}

/**
 * Reset back to landing screen
 */
function resetToLanding() {
  state.currentPackage = null;
  state.currentVersion = null;
  document.getElementById('landing-view').classList.remove('hidden');
  document.getElementById('package-view').classList.add('hidden');
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear-btn').classList.add('hidden');
  closeAutocomplete();
  syncUrlQuery();
}

/**
 * Sync URL query string (?pkg=react or ?compare=react,preact)
 */
function syncUrlQuery() {
  const params = new URLSearchParams();
  if (state.currentPackage) {
    const spec = state.currentVersion ? `${state.currentPackage}@${state.currentVersion}` : state.currentPackage;
    params.set('pkg', spec);
  }
  if (state.compareList.length > 0) {
    params.set('compare', state.compareList.join(','));
  }

  const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
  window.history.replaceState({}, '', newUrl);
}

/**
 * Load initial state from URL query parameters
 */
function loadStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const pkgParam = params.get('pkg');
  const compareParam = params.get('compare');

  if (compareParam) {
    state.compareList = compareParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CONFIG.MAX_COMPARE_ITEMS);
    updateCompareBadge();
  }

  if (pkgParam) {
    loadPackage(pkgParam);
  } else if (state.compareList.length > 0) {
    toggleCompareModal(true);
  }
}

/**
 * Show temporary toast message
 * @param {string} message
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove('hidden');

  clearTimeout(toast._timeoutId);
  toast._timeoutId = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2600);
}

// ============================================================================
// 9. Autocomplete & Search Input Controller
// ============================================================================

let searchDebounceTimer = null;
let activeAutocompleteIndex = -1;

function setupSearch() {
  const searchInput = document.getElementById('search-input');
  const landingInput = document.getElementById('landing-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const dropdown = document.getElementById('autocomplete-dropdown');

  function handleInput(val) {
    const query = val.trim();
    if (clearBtn) clearBtn.classList.toggle('hidden', query.length === 0);

    clearTimeout(searchDebounceTimer);
    if (query.length < 1) {
      closeAutocomplete();
      return;
    }

    searchDebounceTimer = setTimeout(async () => {
      try {
        const results = await fetchSearch(query);
        renderAutocomplete(results);
      } catch (err) {
        console.warn('Search autocomplete failed:', err);
      }
    }, 300);
  }

  searchInput.addEventListener('input', (e) => handleInput(e.target.value));

  if (landingInput) {
    landingInput.addEventListener('input', (e) => {
      searchInput.value = e.target.value;
      handleInput(e.target.value);
    });
    landingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = landingInput.value.trim();
        if (val) loadPackage(val);
      }
    });
  }

  searchInput.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.autocomplete-item');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        activeAutocompleteIndex = (activeAutocompleteIndex + 1) % items.length;
        highlightAutocompleteItem(items);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        activeAutocompleteIndex = (activeAutocompleteIndex - 1 + items.length) % items.length;
        highlightAutocompleteItem(items);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeAutocompleteIndex >= 0 && items[activeAutocompleteIndex]) {
        items[activeAutocompleteIndex].click();
      } else {
        const val = searchInput.value.trim();
        if (val) {
          closeAutocomplete();
          loadPackage(val);
        }
      }
    } else if (e.key === 'Escape') {
      closeAutocomplete();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      if (landingInput) landingInput.value = '';
      clearBtn.classList.add('hidden');
      closeAutocomplete();
      searchInput.focus();
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#header-search-wrap')) {
      closeAutocomplete();
    }
  });
}

function renderAutocomplete(results) {
  const dropdown = document.getElementById('autocomplete-dropdown');
  dropdown.innerHTML = '';
  activeAutocompleteIndex = -1;

  if (!results || results.length === 0) {
    closeAutocomplete();
    return;
  }

  results.forEach((item) => {
    const pkg = item.package;
    if (!pkg) return;

    const li = document.createElement('li');
    li.className = 'autocomplete-item';
    li.setAttribute('role', 'option');

    li.innerHTML = `
      <div class="autocomplete-item-header">
        <span class="autocomplete-pkg-name font-mono">${escapeHtml(pkg.name)}</span>
        <span class="autocomplete-pkg-ver font-mono">v${escapeHtml(pkg.version)}</span>
      </div>
      <p class="autocomplete-pkg-desc">${escapeHtml(pkg.description || 'No description')}</p>
    `;

    li.onclick = () => {
      closeAutocomplete();
      loadPackage(pkg.name);
    };

    dropdown.appendChild(li);
  });

  dropdown.classList.remove('hidden');
}

function highlightAutocompleteItem(items) {
  items.forEach((item, idx) => {
    item.classList.toggle('active', idx === activeAutocompleteIndex);
    if (idx === activeAutocompleteIndex) {
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

function closeAutocomplete() {
  const dropdown = document.getElementById('autocomplete-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
  activeAutocompleteIndex = -1;
}

// ============================================================================
// 10. Theme Management & Keyboard Shortcuts
// ============================================================================

function setupTheme() {
  state.theme = 'light';
  document.documentElement.removeAttribute('data-theme');
}

function setupKeyboardShortcuts() {
  const searchInput = document.getElementById('search-input');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const shortcutsBtn = document.getElementById('shortcuts-btn');
  const closeShortcutsBtn = document.getElementById('close-shortcuts-btn');

  shortcutsBtn.addEventListener('click', () => {
    shortcutsModal.classList.remove('hidden');
  });

  closeShortcutsBtn.addEventListener('click', () => {
    shortcutsModal.classList.add('hidden');
  });

  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) {
      shortcutsModal.classList.add('hidden');
    }
  });

  window.addEventListener('keydown', (e) => {
    const isTyping =
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable;

    if (e.key === '/' && !isTyping) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === 'c' && !isTyping) {
      e.preventDefault();
      toggleCompareModal();
    } else if (e.key === '?' && !isTyping) {
      e.preventDefault();
      shortcutsModal.classList.toggle('hidden');
    } else if (e.key === 'Escape') {
      closeAutocomplete();
      shortcutsModal.classList.add('hidden');
      const compareModal = document.getElementById('compare-modal');
      if (compareModal && !compareModal.classList.contains('hidden')) {
        toggleCompareModal(false);
      }
    }
  });
}

// ============================================================================
// 11. Event Listeners Setup
// ============================================================================

function setupEventListeners() {
  // Brand Logo click resets to landing
  document.getElementById('brand-link').addEventListener('click', (e) => {
    e.preventDefault();
    resetToLanding();
  });

  // Back to Explore home button
  document.getElementById('back-home-btn').addEventListener('click', resetToLanding);

  // Version selector dropdown change
  document.getElementById('version-select').addEventListener('change', (e) => {
    switchVersion(e.target.value);
  });

  // Popular package chips on landing
  document.getElementById('popular-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-btn');
    if (btn && btn.dataset.pkg) {
      loadPackage(btn.dataset.pkg);
    }
  });

  // Recent searches clear button
  const clearRecentBtn = document.getElementById('clear-recent-btn');
  if (clearRecentBtn) {
    clearRecentBtn.addEventListener('click', () => {
      state.recentSearches = [];
      try {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.RECENT);
      } catch {
        // ignore
      }
      renderRecentSearches();
    });
  }

  // Click on recent search chips (delegated)
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-btn');
    if (chip && chip.dataset.pkg && !e.target.closest('#popular-chips')) {
      loadPackage(chip.dataset.pkg);
    }
  });

  // Install snippet tabs (npm, pnpm, yarn, bun)
  document.querySelectorAll('.snippet-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.snippet-tabs .tab-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      state.activeInstallPm = btn.dataset.pm;
      renderInstallSnippet();
    });
  });

  // Copy install snippet button
  document.getElementById('copy-snippet-btn').addEventListener('click', async () => {
    const code = document.getElementById('install-command-text').textContent;
    try {
      await navigator.clipboard.writeText(code);
      const copyIcon = document.getElementById('copy-icon');
      const checkIcon = document.getElementById('check-icon');
      copyIcon.classList.add('hidden');
      checkIcon.classList.remove('hidden');
      showToast('Install command copied to clipboard!');
      setTimeout(() => {
        copyIcon.classList.remove('hidden');
        checkIcon.classList.add('hidden');
      }, 1800);
    } catch {
      showToast('Press Ctrl+C to copy command');
    }
  });

  // Share button
  document.getElementById('share-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('Link copied to clipboard!');
    } catch {
      showToast(window.location.href);
    }
  });

  // Add current package to compare button
  document.getElementById('add-compare-btn').addEventListener('click', () => {
    if (!state.currentPackage) return;
    if (state.compareList.includes(state.currentPackage)) {
      removeFromCompare(state.currentPackage);
    } else {
      addToCompare(state.currentPackage);
    }
  });

  // Compare mode toggle button in top nav
  document.getElementById('compare-toggle-btn').addEventListener('click', () => {
    toggleCompareModal();
  });

  // Close compare modal button
  document.getElementById('close-compare-btn').addEventListener('click', () => {
    toggleCompareModal(false);
  });

  // Compare modal overlay backdrop click
  document.getElementById('compare-modal').addEventListener('click', (e) => {
    if (e.target.id === 'compare-modal') {
      toggleCompareModal(false);
    }
  });

  // Add package form in compare modal
  document.getElementById('compare-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('compare-search-input');
    const val = input.value.trim();
    if (val) {
      addToCompare(val);
      input.value = '';
    }
  });

  // Clear all compare packages
  document.getElementById('clear-compare-btn').addEventListener('click', () => {
    state.compareList = [];
    updateCompareBadge();
    syncUrlQuery();
    fetchAndRenderCompare();
    showToast('Cleared compare list');
  });

  // Share compare link
  document.getElementById('copy-compare-link-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('Compare link copied to clipboard!');
    } catch {
      showToast(window.location.href);
    }
  });

  // Remove package from compare table (event delegation)
  document.getElementById('compare-thead-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-compare-btn');
    if (btn && btn.dataset.pkg) {
      removeFromCompare(btn.dataset.pkg);
    }
  });

  // Alternatives click actions (delegation)
  document.getElementById('alternatives-grid').addEventListener('click', (e) => {
    const target = e.target;
    if (target.dataset.action === 'explore' || target.classList.contains('alt-name')) {
      const pkg = target.dataset.pkg;
      if (pkg) loadPackage(pkg);
    } else if (target.dataset.action === 'compare') {
      const pkg = target.dataset.pkg;
      if (pkg) addToCompare(pkg);
    }
  });

  // Global Retry buttons
  document.getElementById('package-retry-btn').addEventListener('click', () => {
    if (state.currentPackage) loadPackage(state.currentPackage);
  });

  document.getElementById('size-retry-btn').addEventListener('click', () => {
    if (state.currentPackage && state.currentVersion) {
      renderSizes(null, true);
      fetchBundleSize(state.currentPackage, state.currentVersion)
        .then((sz) => renderSizes(sz, false, null))
        .catch((err) => renderSizes(null, false, err));
    }
  });

  // Handle browser back/forward buttons (popstate)
  window.addEventListener('popstate', loadStateFromUrl);
}

// ============================================================================
// 12. Main Bootstrapper
// ============================================================================

function init() {
  try {
    const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.RECENT);
    if (stored) state.recentSearches = JSON.parse(stored);
  } catch {
    state.recentSearches = [];
  }

  setupTheme();
  setupSearch();
  setupKeyboardShortcuts();
  setupEventListeners();
  renderRecentSearches();
  loadStateFromUrl();
}

// Run bootstrapper when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
