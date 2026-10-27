#!/usr/bin/env node
/**
 * npm-downloads-badge.mjs
 *
 * 为什么有这个脚本：npm 官方的 `downloads/point/last-month` 接口从 2026-07 起对**所有包**
 * 都返回 0（连 express / lodash 也一样），于是 shields.io 的 `npm/dm` 徽章渲染成红色 `0/month`。
 * 但 `downloads/range/…` 接口是好的 —— 这个脚本用 range 接口算「最近 N 个完整天（UTC）」的合计，
 * 生成 shields.io endpoint badge 所需的那份 JSON：
 *
 *     { "schemaVersion": 1, "label": "npm downloads", "message": "10.3k/month", "color": "blue" }
 *
 * 韧性规则（重要）：接口失败 / 非 200 / 返回不完整 / 合计为 0 时，**不产出新数字**，
 * 而是把 --previous 指定的上一份徽章 JSON 原样保留下来，避免 npm 故障把徽章打回 0。
 *
 * 零依赖，Node >= 18（内置 fetch）。用法见 --help。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DAY_MS = 86_400_000;
const RANGE_API = 'https://api.npmjs.org/downloads/range';
const LABEL = 'npm downloads';
const COLOR = 'blue';
const MESSAGE_RE = /^[0-9.]+k?\/month$/;

const DEFAULTS = {
  packageName: 'sage-mem',
  days: 30,
  out: '',
  previous: '',
  end: '', // YYYY-MM-DD；默认 = 今天(UTC) 的前一天
  timeoutMs: 20_000,
  maxStaleDays: 7,
  dryRun: false,
};

const HELP = `用法: node .github/scripts/npm-downloads-badge.mjs [选项]

  --package <name>   要统计的 npm 包名（默认 sage-mem）
  --days <n>         统计窗口长度，单位「完整天（UTC）」（默认 30）
  --out <file>       把生成的 badge JSON 写到这个文件（不给就只打印）
  --previous <file>  上一份已发布的 badge JSON；接口失败时原样保留它的内容
  --end <YYYY-MM-DD> 窗口最后一天（默认：今天 UTC 的前一天）
  --timeout <ms>     单次请求超时（默认 20000）
  --max-stale-days <n>
                     窗口末尾连续这么多天没有非零数据就视为数据陈旧、拒绝覆盖（默认 7）
  --dry-run          只计算并打印，永不写文件
  -h, --help         显示本帮助

示例（本地算一次并生成 seed 文件）:
  node .github/scripts/npm-downloads-badge.mjs --package sage-mem --out .github/badges-seed/npm-downloads.json

退出码: 0 = 成功（或已保留旧值）；1 = 无法计算且没有可保留的旧值；2 = 参数错误
`;

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--package': opts.packageName = next(); break;
      case '--days': opts.days = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--previous': opts.previous = next(); break;
      case '--end': opts.end = next(); break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--max-stale-days': opts.maxStaleDays = Number(next()); break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': process.stdout.write(HELP); process.exit(0); break;
      default: throw new Error(`不认识的参数: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 365) {
    throw new Error('--days 必须是 1..365 的整数');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) {
    throw new Error('--timeout 必须 >= 1000 毫秒');
  }
  if (!Number.isInteger(opts.maxStaleDays) || opts.maxStaleDays < 0) {
    throw new Error('--max-stale-days 必须是 >= 0 的整数');
  }
  if (opts.end && !/^\d{4}-\d{2}-\d{2}$/.test(opts.end)) {
    throw new Error('--end 必须是 YYYY-MM-DD');
  }
  return opts;
}

// ── 日期工具（全部按 UTC，npm 的 download 统计也按 UTC 日切分） ──────────────

function toDay(date) {
  return date.toISOString().slice(0, 10);
}

function parseDay(day) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`非法日期: ${day}`);
  return new Date(ms);
}

function shiftDays(day, delta) {
  return toDay(new Date(parseDay(day).getTime() + delta * DAY_MS));
}

function defaultEndDay(now = new Date()) {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return toDay(new Date(todayUtcMs - DAY_MS));
}

// ── 输出辅助：GitHub Actions 注解 + step summary ────────────────────────────

function ghAnnotation(level, message) {
  // 本地跑时没有这个环境变量，退化成普通日志。
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::${level}::${String(message).replace(/\r?\n/g, ' ')}\n`);
  } else {
    const prefix = level === 'error' ? 'ERROR' : level === 'warning' ? 'WARN' : 'INFO';
    process.stdout.write(`[${prefix}] ${message}\n`);
  }
}

function appendStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    writeFileSync(file, `${markdown}\n`, { flag: 'a' });
  } catch (error) {
    console.error(`[WARN] 写 step summary 失败: ${error.message}`);
  }
}

// ── 数据获取与计算 ─────────────────────────────────────────────────────────

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'sage-mem-downloads-badge/1.0 (+https://github.com/gezi-wen/sage-mem)',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`响应不是合法 JSON: ${text.slice(0, 300)}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`请求超时（>${timeoutMs}ms）: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function computeWindow(opts) {
  const end = opts.end || defaultEndDay();
  const start = shiftDays(end, -(opts.days - 1));
  const url = `${RANGE_API}/${start}:${end}/${encodeURIComponent(opts.packageName)}`;

  console.log(`[INFO] 统计对象: ${opts.packageName}`);
  console.log(`[INFO] 窗口: ${start} .. ${end}（${opts.days} 个完整天，UTC）`);
  console.log(`[INFO] range 接口: ${url}`);

  const data = await fetchJson(url, opts.timeoutMs);
  if (!data || !Array.isArray(data.downloads)) {
    throw new Error('响应结构异常：缺少 downloads 数组');
  }
  if (data.package && data.package !== opts.packageName) {
    throw new Error(`响应里的 package 是 ${data.package}，与请求的 ${opts.packageName} 不一致`);
  }
  if ((data.start && data.start !== start) || (data.end && data.end !== end)) {
    console.warn(`[WARN] 接口回报的窗口 ${data.start}..${data.end} 与请求的 ${start}..${end} 不同，按实际回报窗口求和`);
  }

  const byDay = new Map();
  for (const row of data.downloads) {
    if (!row || typeof row.day !== 'string') continue;
    const value = Number(row.downloads);
    byDay.set(row.day, Number.isFinite(value) && value >= 0 ? value : 0);
  }

  const days = [];
  let total = 0;
  let zeroDays = [];
  let missingDays = [];
  for (let index = 0; index < opts.days; index += 1) {
    const day = shiftDays(start, index);
    if (!byDay.has(day)) {
      missingDays.push(day);
      days.push({ day, downloads: null });
      continue;
    }
    const value = byDay.get(day);
    if (value === 0) zeroDays.push(day);
    total += value;
    days.push({ day, downloads: value });
  }

  // 末尾连续「非零数据」缺失：用于识别「接口还在 200，但数据停更/被清空」的故障。
  let trailingStale = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const value = days[index].downloads;
    if (value === 0 || value === null) trailingStale += 1;
    else break;
  }

  console.log('');
  console.log('  day          downloads');
  console.log('  -----------  ---------');
  for (const row of days) {
    console.log(`  ${row.day}  ${row.downloads === null ? '(缺失)' : String(row.downloads).padStart(9)}`);
  }
  console.log('');
  console.log(`[INFO] 缺失天数（接口没返回这一天）: ${missingDays.length}${missingDays.length ? ` → ${missingDays.join(', ')}` : ''}`);
  console.log(`[INFO] 零下载天数（返回 0，按 0 如实求和）: ${zeroDays.length}${zeroDays.length ? ` → ${zeroDays.join(', ')}` : ''}`);
  console.log(`[INFO] 末尾连续无数据天数: ${trailingStale}`);
  console.log(`[INFO] 窗口合计: ${total}`);

  const coveredDays = opts.days - missingDays.length;
  const minCovered = Math.ceil(opts.days * 0.9);
  if (coveredDays < minCovered) {
    throw new Error(`数据不完整：窗口 ${opts.days} 天只返回了 ${coveredDays} 天（要求至少 ${minCovered} 天）`);
  }
  if (opts.maxStaleDays > 0 && trailingStale > opts.maxStaleDays) {
    throw new Error(`数据疑似停更：窗口末尾连续 ${trailingStale} 天没有非零数据（阈值 ${opts.maxStaleDays} 天）`);
  }
  if (!(total > 0)) {
    throw new Error(`合计为 ${total}，拒绝用 0 覆盖已有徽章`);
  }

  return { start, end, days, total, zeroDays, missingDays, trailingStale, coveredDays };
}

// ── badge JSON ────────────────────────────────────────────────────────────

/** 1000 及以上用 k 缩写并保留一位小数：10321 → "10.3k"、1000 → "1k"。 */
function formatCount(total) {
  if (total < 1000) return String(total);
  const tens = Math.floor(total / 100); // 10321 → 103
  const value = tens / 10; // → 10.3
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)}k`;
}

function buildBadge(total) {
  const badge = {
    schemaVersion: 1,
    label: LABEL,
    message: `${formatCount(total)}/month`,
    color: COLOR,
  };
  // 自检：这条 message 必须能被 shields.io 渲染，也是验收正则。
  if (!MESSAGE_RE.test(badge.message)) {
    throw new Error(`生成的 message 不合规: ${badge.message}`);
  }
  return badge;
}

function readPrevious(path) {
  if (!path) return null;
  const file = resolve(path);
  if (!existsSync(file)) {
    console.log(`[INFO] 没有上一份徽章文件（${file}），本次是首次生成`);
    return null;
  }
  const raw = readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 1 || typeof parsed?.label !== 'string' || typeof parsed?.message !== 'string' || typeof parsed?.color !== 'string') {
      throw new Error('字段不完整');
    }
    if (!MESSAGE_RE.test(parsed.message)) throw new Error(`message 不合规: ${parsed.message}`);
    return { raw, parsed };
  } catch (error) {
    console.warn(`[WARN] 上一份徽章文件无法解析（${error.message}），忽略: ${file}`);
    return null;
  }
}

function writeOut(path, text) {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  console.log(`[INFO] 已写入: ${file}`);
}

function summary({ result, badge, preserved, reason }) {
  const lines = ['## npm downloads badge', ''];
  if (preserved) {
    lines.push(`- 状态: **保留旧值**（${reason}）`);
    lines.push(`- 当前徽章: \`${badge.message}\``);
  } else {
    lines.push(`- 窗口: \`${result.start}\` .. \`${result.end}\`（${result.days.length} 天）`);
    lines.push(`- 合计: **${result.total}** 次下载`);
    lines.push(`- 徽章: \`${badge.label}\` → \`${badge.message}\``);
    lines.push(`- 零下载天数: ${result.zeroDays.length}${result.zeroDays.length ? `（${result.zeroDays.join(', ')}）` : ''}`);
    lines.push(`- 缺失天数: ${result.missingDays.length}${result.missingDays.length ? `（${result.missingDays.join(', ')}）` : ''}`);
  }
  appendStepSummary(lines.join('\n'));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  let result;
  try {
    result = await computeWindow(opts);
  } catch (error) {
    console.error(`[ERROR] 无法计算下载量: ${error.message}`);
    const previous = readPrevious(opts.previous);
    if (!previous) {
      ghAnnotation('error', `npm downloads badge 未更新，且没有可保留的旧值: ${error.message}`);
      summary({ preserved: true, badge: { label: LABEL, message: '(none)' }, reason: error.message });
      process.exit(1);
    }
    ghAnnotation('warning', `npm downloads badge 未更新（${error.message}）；保留旧值 ${previous.parsed.message}`);
    if (opts.out && !opts.dryRun) {
      // 原样写回：workflow 里用 cmp 判断「有没有变化」，内容不变就不会推提交。
      writeOut(opts.out, previous.raw);
    } else {
      console.log(`[INFO] --dry-run / 未指定 --out：只打印，不写文件`);
      console.log(previous.raw.trimEnd());
    }
    summary({ preserved: true, badge: previous.parsed, reason: error.message });
    process.exit(0);
  }

  const badge = buildBadge(result.total);
  const text = `${JSON.stringify(badge, null, 2)}\n`;
  console.log('');
  console.log(`[INFO] 合计 ${result.total} → ${badge.message}`);
  console.log(text.trimEnd());

  if (opts.dryRun) {
    console.log('[INFO] --dry-run：不写文件');
  } else if (opts.out) {
    writeOut(opts.out, text);
  } else {
    console.log('[INFO] 未指定 --out：结果只打印，不写文件');
  }

  ghAnnotation('notice', `npm downloads ${result.start}..${result.end}: ${result.total} → ${badge.message}`);
  summary({ preserved: false, result, badge });
}

main().catch((error) => {
  console.error(`[ERROR] 未预期的失败: ${error.stack || error.message}`);
  process.exit(1);
});
