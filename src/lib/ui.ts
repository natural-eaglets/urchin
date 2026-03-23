/**
 * Visual helpers for CLI output — premium terminal UI.
 */
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import Table from 'cli-table3';
import figures from 'figures';

// ─── Brand palette ──────────────────────────────────────
const CIFER_GREEN = '#00FF88';
const CIFER_CYAN  = '#00D4FF';
const CIFER_PURPLE = '#A855F7';
const CIFER_DARK  = '#0A0A0A';

const ACCENT = chalk.hex(CIFER_GREEN);
const CYAN   = chalk.hex(CIFER_CYAN);
const PURPLE = chalk.hex(CIFER_PURPLE);
const DIM    = chalk.dim;
const BOLD   = chalk.bold;
const WARN   = chalk.yellow;
const ERR    = chalk.red;
const OK     = chalk.green;

export { ACCENT, CYAN, PURPLE, DIM, BOLD, WARN, ERR, OK };

// ─── Gradient presets ───────────────────────────────────
const ciferGrad = gradient([CIFER_GREEN, CIFER_CYAN]);
const purpleGrad = gradient([CIFER_CYAN, CIFER_PURPLE]);

export { ciferGrad, purpleGrad };

// ─── ASCII Art Banner ───────────────────────────────────
const LOGO_ART = `
 ██╗   ██╗██████╗  ██████╗██╗  ██╗██╗███╗   ██╗
 ██║   ██║██╔══██╗██╔════╝██║  ██║██║████╗  ██║
 ██║   ██║██████╔╝██║     ███████║██║██╔██╗ ██║
 ██║   ██║██╔══██╗██║     ██╔══██║██║██║╚██╗██║
 ╚██████╔╝██║  ██║╚██████╗██║  ██║██║██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝`.trimStart();

export function banner(compact = false) {
  if (compact) {
    console.log('');
    console.log(ciferGrad.multiline(LOGO_ART));
    console.log('');
    return;
  }

  console.log('');
  console.log(ciferGrad.multiline(LOGO_ART));
  console.log('');
  console.log(
    chalk.gray('  ') +
    ACCENT.bold('Quantum-Encrypted Vault') +
    chalk.gray(' │ ') +
    DIM('v0.2.0') +
    chalk.gray(' │ ') +
    DIM('ML-KEM-768 + AES-256-GCM')
  );
  console.log('');
}

// ─── Box frame ──────────────────────────────────────────
export function box(content: string, title?: string) {
  console.log(
    boxen(content, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 0, bottom: 0, left: 1, right: 0 },
      borderStyle: 'round',
      borderColor: 'green',
      title: title ? ` ${title} ` : undefined,
      titleAlignment: 'left',
    })
  );
}

// ─── Section header ─────────────────────────────────────
export function header(title: string, subtitle?: string) {
  const line = ACCENT('─'.repeat(3));
  const sub = subtitle ? `  ${DIM(subtitle)}` : '';
  console.log(`\n  ${line} ${ACCENT.bold(title)}${sub} ${line}`);
}

// ─── Key-value pair ─────────────────────────────────────
export function kv(key: string, value: string, indent = 4) {
  const pad = ' '.repeat(indent);
  console.log(`${pad}${DIM(key)}  ${value}`);
}

// ─── Status badges ──────────────────────────────────────
export function badge(label: string, color: 'green' | 'cyan' | 'purple' | 'yellow' | 'red' | 'dim' = 'green') {
  const colors: Record<string, typeof ACCENT> = {
    green: ACCENT,
    cyan: CYAN,
    purple: PURPLE,
    yellow: WARN,
    red: ERR,
    dim: DIM,
  };
  const c = colors[color] || ACCENT;
  return c(`[${label}]`);
}

// ─── Success / Error / Warn messages ────────────────────
export function success(msg: string) {
  console.log(`  ${ACCENT(figures.tick)} ${msg}`);
}

export function error(msg: string) {
  console.error(`  ${ERR(figures.cross)} ${msg}`);
}

export function warn(msg: string) {
  console.log(`  ${WARN(figures.warning)} ${msg}`);
}

export function info(msg: string) {
  console.log(`  ${CYAN(figures.info)} ${msg}`);
}

// ─── Progress bar (static, for dashboard) ───────────────
export function progressBar(current: number, total: number, width = 20): string {
  if (total === 0) return DIM('░'.repeat(width));
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return ACCENT('█'.repeat(filled)) + DIM('░'.repeat(empty));
}

// ─── Table-like file listing ────────────────────────────
export function fileRow(
  name: string,
  size: string,
  keyName: string,
  provider: string,
  date: string,
  cid: string,
  id: string,
) {
  const provIcon = providerEmoji(provider);
  const row = [
    `  ${provIcon} ${BOLD(name)}`,
    DIM(size),
    `${ACCENT('⚷')} ${keyName}`,
    DIM(date),
  ].join(chalk.gray('  │  '));

  console.log(row);
  console.log(`    ${DIM(`${cid}`)}`);
}

// ─── Create a clean table ───────────────────────────────
export function createTable(head: string[], colWidths?: number[]): Table.Table {
  const opts: Record<string, any> = {
    head: head.map(h => ACCENT.bold(h)),
    chars: {
      'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
      'right': '│', 'right-mid': '┤', 'middle': '│',
    },
    style: {
      head: [],
      border: ['gray'],
      'padding-left': 1,
      'padding-right': 1,
    },
  };
  if (colWidths) opts.colWidths = colWidths;
  return new Table(opts);
}

// ─── Provider display ───────────────────────────────────
export function providerEmoji(provider: string): string {
  switch (provider) {
    case 'storacha': return '🌐';
    case 'ipfs-pinning': return '📌';
    case 's3': return '☁️';
    case 'local': return '💾';
    default: return '📦';
  }
}

export function providerLabel(name: string, isDefault: boolean): string {
  const icon = providerEmoji(name);
  const label = BOLD(name);
  const tag = isDefault ? ACCENT(' ★ default') : '';
  return `${icon}  ${label}${tag}`;
}

// ─── Key display ────────────────────────────────────────
export function keyLabel(name: string, secretId: number): string {
  return `${ACCENT('⚷')}  ${BOLD(name)}  ${DIM(`#${secretId}`)}`;
}

// ─── Separator ──────────────────────────────────────────
export function sep(width = 50) {
  console.log(`  ${DIM('─'.repeat(width))}`);
}

// ─── Status dashboard (new premium layout) ──────────────
export function dashboard(data: {
  user: string;
  mode: string;
  providers: Array<{ name: string; desc: string; fileCount: number; isDefault: boolean }>;
  keys: Array<{ name: string; secretId: number; fileCount: number; totalSize: number }>;
  recentFiles: Array<{ name: string; size: number; keyName: string; provider: string; date: string; cid: string }>;
}) {
  // ─── User line ──────────────────────────────────────
  const userLine = `${ACCENT(figures.circleFilled)} ${BOLD(data.user)}  ${badge(data.mode, 'cyan')}`;
  console.log(`  ${userLine}`);
  console.log('');

  // ─── Providers section ──────────────────────────────
  header('PROVIDERS');
  console.log('');
  for (const p of data.providers) {
    const dot = p.isDefault ? ACCENT(figures.circleFilled) : DIM(figures.circle);
    const icon = providerEmoji(p.name);
    const defTag = p.isDefault ? ACCENT(' ★') : '';
    const files = DIM(`${p.fileCount} file${p.fileCount !== 1 ? 's' : ''}`);
    console.log(`    ${dot} ${icon}  ${BOLD(p.name)}${defTag}  ${DIM('│')}  ${DIM(p.desc)}  ${DIM('│')}  ${files}`);
  }
  console.log('');

  // ─── Keys section ───────────────────────────────────
  header('KEYS', 'CIFER ML-KEM-768');
  console.log('');
  if (data.keys.length === 0) {
    console.log(`    ${DIM('No keys yet.')} Run ${ACCENT.bold('urchin key create')}`);
  } else {
    for (const k of data.keys) {
      const bar = progressBar(k.fileCount, Math.max(k.fileCount, 5), 10);
      console.log(
        `    ${ACCENT('⚷')}  ${BOLD(k.name.padEnd(16))}` +
        `${DIM('secret')} ${PURPLE(`#${k.secretId}`)}  ` +
        `${DIM('│')}  ${bar} ${DIM(`${k.fileCount} files`)}  ` +
        `${DIM('│')}  ${DIM(formatBytes(k.totalSize))}`
      );
    }
  }
  console.log('');

  // ─── Recent files ───────────────────────────────────
  if (data.recentFiles.length > 0) {
    header('RECENT FILES');
    console.log('');

    const table = createTable(['', 'File', 'Size', 'Key', 'Date']);
    for (const f of data.recentFiles) {
      table.push([
        providerEmoji(f.provider),
        BOLD(f.name),
        DIM(formatBytes(f.size)),
        `${ACCENT('⚷')} ${f.keyName}`,
        DIM(f.date),
      ]);
    }
    console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));
    console.log('');
  }

  // ─── Footer ─────────────────────────────────────────
  sep();
  console.log(`  ${DIM(figures.arrowRight)} ${DIM('push')} ${chalk.gray('file')}  ${DIM(figures.arrowLeft)} ${DIM('pull')} ${chalk.gray('file')}  ${DIM(figures.bullet)} ${DIM('ls')}  ${DIM(figures.bullet)} ${DIM('key create')}  ${DIM(figures.bullet)} ${DIM('--help')}`);
  console.log(`  ${DIM(`Encryption: ML-KEM-768 (post-quantum) + AES-256-GCM`)}`);
  console.log(`  ${DIM(`Docs: ${CYAN('https://sdk.cifer-security.com/docs/')}`)}`);
  console.log('');
}

// ─── Formatters ─────────────────────────────────────────
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Help footer ────────────────────────────────────────
export function helpFooter() {
  sep();
  console.log(`  ${DIM(`Encryption: ML-KEM-768 (post-quantum) + AES-256-GCM`)}`);
  console.log(`  ${DIM(`Docs: ${CYAN('https://sdk.cifer-security.com/docs/')}`)}`);
  console.log('');
}

// ─── Spinner-style step labels (for push/pull flows) ────
export function step(num: number, total: number, label: string) {
  const counter = DIM(`[${num}/${total}]`);
  console.log(`  ${ACCENT(figures.pointer)} ${counter} ${label}`);
}

// ─── Flow arrow display (file → key → provider) ────────
export function flowArrow(file: string, key: string, provider: string) {
  console.log(
    `  ${BOLD(file)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key)} ${ACCENT('→')} ${providerEmoji(provider)} ${BOLD(provider)}`
  );
}
