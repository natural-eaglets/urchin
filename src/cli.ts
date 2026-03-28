#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { registerAuthCommands } from './commands/auth.js';
import { registerKeyCommands } from './commands/keys.js';
import { registerFileCommands } from './commands/files.js';
import { registerConfigCommands } from './commands/config.js';
import {
  banner, header, dashboard as renderDashboard,
  helpFooter, formatBytes, ACCENT, DIM, BOLD, CYAN, PURPLE,
  success, error as uiError, info, warn, sep, providerEmoji,
  createTable, progressBar,
} from './lib/ui.js';
import { loadStore, saveStore, getSession } from './lib/store.js';
import { listProviders, getProvider } from './lib/storage.js';
import { restoreWeb2Session, createWeb2Secret, encryptFileWeb2, decryptFileWeb2 } from './lib/cifer.js';
import { fileSelector, ItemType } from 'inquirer-file-selector';
import { execFile, exec as execCb } from 'child_process';
import { promisify } from 'util';
import ora from 'ora';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __cliDirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__cliDirname, '..', 'package.json'), 'utf-8'));

const execAsync = promisify(execFile);
const execShell = promisify(execCb);

const program = new Command();

program
  .name('urchin')
  .description(
    ACCENT.bold('Urchin') +
    ' — Quantum-encrypted file vault\n\n' +
    DIM('  Encrypt with CIFER (ML-KEM-768 + AES-256-GCM)\n') +
    DIM('  Store on Filecoin, IPFS, or locally\n')
  )
  .version(PKG.version)
  .action(async () => {
    await interactiveMode();
  });

registerAuthCommands(program);
registerKeyCommands(program);
registerFileCommands(program);
registerConfigCommands(program);

// ─── Top-level shortcuts ─────────────────────────────────
program
  .command('push')
  .description('Encrypt & upload a file (interactive if no args)')
  .argument('[file-path]', 'Path to file')
  .option('-k, --key <name>', 'Encryption key name or ID')
  .option('-p, --provider <name>', 'Storage provider (storacha, local)')
  .action(async (filePath: string | undefined, opts: any) => {
    const fileCmd = program.commands.find(c => c.name() === 'file');
    const pushCmd = fileCmd?.commands.find((c: any) => c.name() === 'push');
    if (pushCmd) {
      await pushCmd.parseAsync([
        ...(filePath ? [filePath] : []),
        ...(opts.key ? ['-k', opts.key] : []),
        ...(opts.provider ? ['-p', opts.provider] : []),
      ], { from: 'user' });
    }
  });

program
  .command('pull')
  .description('Download & decrypt a file (interactive if no args)')
  .argument('[name-or-id]', 'File name or ID')
  .option('-o, --output <path>', 'Output path')
  .action(async (nameOrId: string | undefined, opts: any) => {
    const fileCmd = program.commands.find(c => c.name() === 'file');
    const pullCmd = fileCmd?.commands.find((c: any) => c.name() === 'pull');
    if (pullCmd) {
      await pullCmd.parseAsync([...(nameOrId ? [nameOrId] : []), ...(opts.output ? ['-o', opts.output] : [])], { from: 'user' });
    }
  });

program
  .command('ls')
  .description('List files')
  .option('-k, --key <name>', 'Filter by key')
  .action(async (opts: any) => {
    const fileCmd = program.commands.find(c => c.name() === 'file');
    const listCmd = fileCmd?.commands.find((c: any) => c.name() === 'list');
    if (listCmd) {
      await listCmd.parseAsync([...(opts.key ? ['-k', opts.key] : [])], { from: 'user' });
    }
  });

program.parse();

// ═════════════════════════════════════════════════════════
//  SYSTEM HELPERS
// ═════════════════════════════════════════════════════════

async function openInBrowser(url: string) {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      await execAsync('open', [url]);
    } else if (platform === 'win32') {
      await execAsync('cmd', ['/c', 'start', url]);
    } else {
      await execAsync('xdg-open', [url]);
    }
    success(`Opened in browser`);
    console.log(`    ${DIM(url)}`);
  } catch {
    // Fallback: just show the URL
    info(`Open this URL in your browser:`);
    console.log(`    ${CYAN(url)}`);
  }
}

async function copyToClipboard(text: string) {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      await execShell(`echo ${JSON.stringify(text)} | pbcopy`);
    } else if (platform === 'win32') {
      await execShell(`echo ${JSON.stringify(text)} | clip`);
    } else {
      await execShell(`echo ${JSON.stringify(text)} | xclip -selection clipboard`);
    }
    success(`Copied to clipboard`);
    console.log(`    ${DIM(text)}`);
  } catch {
    info(`CID: ${CYAN(text)}`);
    console.log(`    ${DIM('(could not copy to clipboard)')}`);
  }
}

// ═════════════════════════════════════════════════════════
//  FILE SELECTOR HELPERS
// ═════════════════════════════════════════════════════════

const fileSelectorTheme = {
  style: {
    file: (text: string) => ACCENT(text),
    directory: (text: string) => CYAN.bold(text + '/'),
    currentDir: (text: string) => chalk.white.bold(text),
    help: () => DIM('  ↑↓ navigate  → enter folder  ← go back  ⏎ confirm  esc cancel'),
  },
  prefix: {
    file: '  📄 ',
    directory: '  📂 ',
    currentDir: '  📍 ',
  },
};

const dirSelectorTheme = {
  style: {
    directory: (text: string) => CYAN.bold(text + '/'),
    currentDir: (text: string) => chalk.white.bold(text),
    help: () => DIM('  ↑↓ navigate  → enter folder  ← go back  ⏎ select folder  esc cancel'),
  },
  prefix: {
    directory: '  📂 ',
    currentDir: '  📍 ',
  },
};

function defaultFilter(item: { path: string; isDirectory: boolean }) {
  const name = path.basename(item.path);
  if (name.startsWith('.') && name !== '..') return false;
  if (name === 'node_modules' || name === 'dist') return false;
  return true;
}

async function pickFile(message = '📄  Select file:'): Promise<string | null> {
  const result = await fileSelector({
    message,
    basePath: process.cwd(),
    type: ItemType.File,
    pageSize: 15,
    allowCancel: true,
    filter: defaultFilter,
    theme: fileSelectorTheme as any,
  });
  return result ? result.path : null;
}

async function pickDirectory(message = '📂  Select folder:'): Promise<string | null> {
  const result = await fileSelector({
    message,
    basePath: process.cwd(),
    type: ItemType.Directory,
    pageSize: 15,
    allowCancel: true,
    filter: defaultFilter,
    theme: dirSelectorTheme as any,
  });
  return result ? result.path : null;
}

async function promptSaveLocation(): Promise<string | null> {
  const { saveTo } = await inquirer.prompt([{
    type: 'list',
    name: 'saveTo',
    message: '💾  Save to:',
    choices: [
      { name: `${ACCENT('.')}  Current directory  ${DIM(`(${process.cwd()})`)}`, value: 'cwd' },
      { name: `${ACCENT('~')}  Home               ${DIM(`(${os.homedir()})`)}`, value: 'home' },
      { name: `${ACCENT('⋯')}  Desktop            ${DIM(`(${path.join(os.homedir(), 'Desktop')})`)}`, value: 'desktop' },
      { name: `${ACCENT('⋯')}  Downloads          ${DIM(`(${path.join(os.homedir(), 'Downloads')})`)}`, value: 'downloads' },
      { name: `${ACCENT('📂')} Browse...           ${DIM('choose a folder')}`, value: 'browse' },
    ],
    loop: false,
  }]);
  return saveTo;
}

async function resolveSavePath(saveTo: string, fileName: string): Promise<string | null> {
  let outputDir: string;
  if (saveTo === 'browse') {
    const dir = await pickDirectory('📂  Select destination folder:');
    if (!dir) { info('Cancelled.'); return null; }
    outputDir = dir;
  } else {
    const dirs: Record<string, string> = {
      cwd: process.cwd(),
      home: os.homedir(),
      desktop: path.join(os.homedir(), 'Desktop'),
      downloads: path.join(os.homedir(), 'Downloads'),
    };
    outputDir = dirs[saveTo] || process.cwd();
  }
  return path.join(outputDir, fileName);
}

// ═════════════════════════════════════════════════════════
//  INTERACTIVE MODE
// ═════════════════════════════════════════════════════════

async function interactiveMode() {
  const store = loadStore();
  const s = store.session;

  banner();

  // Not logged in → auth menu
  if (!s) {
    console.log(`  ${chalk.yellow('⚠')}  Not logged in.\n`);
    await authMenu();
    return;
  }

  // Show dashboard
  showDashboard();

  // Main action loop
  await mainMenu();
}

// ─── Auth Menu (not logged in) ──────────────────────────
async function authMenu() {
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { name: `${ACCENT('→')}  Login to existing account`, value: 'login' },
      { name: `${ACCENT('+')}  Create a new account`, value: 'register' },
      { name: `${DIM('×')}  Exit`, value: 'exit' },
    ],
    loop: false,
  }]);

  if (action === 'login') {
    await program.commands.find(c => c.name() === 'login')?.parseAsync([], { from: 'user' });
    // After login, restart interactive
    const store = loadStore();
    if (store.session) {
      console.log('');
      showDashboard();
      await mainMenu();
    }
  } else if (action === 'register') {
    await program.commands.find(c => c.name() === 'register')?.parseAsync([], { from: 'user' });
    const store = loadStore();
    if (store.session) {
      console.log('');
      showDashboard();
      await mainMenu();
    }
  }
}

// ─── Main Menu (logged in) ──────────────────────────────
async function mainMenu() {
  let running = true;

  while (running) {
    const store = loadStore();
    const fileCount = store.files.length;
    const keyCount = store.vaults.length;

    console.log('');
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: ACCENT('?') + '  What would you like to do?',
      choices: [
        new inquirer.Separator(DIM('─── Files ───')),
        { name: `${ACCENT('↑')}  Push a file          ${DIM('encrypt & upload')}`, value: 'push' },
        { name: `${ACCENT('↓')}  Pull a file          ${DIM('download & decrypt')}`, value: 'pull' },
        { name: `${ACCENT('◆')}  Browse files         ${DIM(`${fileCount} file${fileCount !== 1 ? 's' : ''} in vault`)}`, value: 'browse' },

        new inquirer.Separator(DIM('─── Keys ───')),
        { name: `${ACCENT('+')}  Create a key         ${DIM('ML-KEM-768 key pair')}`, value: 'key-create' },
        { name: `${ACCENT('⚷')}  Manage keys          ${DIM(`${keyCount} key${keyCount !== 1 ? 's' : ''}`)}`, value: 'key-manage' },

        new inquirer.Separator(DIM('─── System ───')),
        { name: `${ACCENT('☁')}  Manage providers     ${DIM('configure storage backends')}`, value: 'providers' },
        { name: `${ACCENT('⚙')}  Settings             ${DIM('view & edit config')}`, value: 'settings' },
        { name: `${ACCENT('○')}  Who am I             ${DIM('session info')}`, value: 'whoami' },
        { name: `${DIM('×')}  Exit`, value: 'exit' },
      ],
      loop: false,
      pageSize: 18,
    }]);

    switch (action) {
      case 'push':
        await interactivePush();
        break;
      case 'pull':
        await interactivePull();
        break;
      case 'browse':
        await interactiveFileBrowser();
        break;
      case 'key-create':
        await interactiveKeyCreate();
        break;
      case 'key-manage':
        await interactiveKeyManage();
        break;
      case 'providers':
        await interactiveProviders();
        break;
      case 'settings':
        await interactiveSettings();
        break;
      case 'whoami':
        interactiveWhoami();
        break;
      case 'exit':
        running = false;
        break;
    }
  }
}

// ═════════════════════════════════════════════════════════
//  INTERACTIVE ACTIONS
// ═════════════════════════════════════════════════════════

// ─── Push ───────────────────────────────────────────────
async function interactivePush() {
  try {
    const session = getSession();
    const store = loadStore();
    const owner = session.mode === 'web2' ? session.email : session.walletAddress;
    const keys = store.vaults.filter(v => v.owner === owner);

    if (keys.length === 0) {
      warn('No keys yet. Let\'s create one first.\n');
      await interactiveKeyCreate();
      return;
    }

    // 1. Pick file with visual browser
    const filePath = await pickFile('📄  Select file to encrypt:');
    if (!filePath) { info('Cancelled.'); return; }

    // 2. Pick key
    let key;
    if (keys.length === 1) {
      key = keys[0];
      info(`Using key ${ACCENT.bold(key.name)}`);
    } else {
      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: ACCENT('⚷') + '  Encryption key:',
        choices: keys.map(k => {
          const fc = store.files.filter(f => f.vaultId === k.id).length;
          return {
            name: `${ACCENT('⚷')} ${BOLD(k.name)}  ${DIM(`secret #${k.secretId}`)}  ${DIM(`(${fc} files)`)}`,
            value: k, short: k.name,
          };
        }),
        loop: false,
      }]);
      key = selected;
    }

    // 3. Pick provider
    const providers = listProviders();
    let providerName = store.settings.defaultProvider || 'storacha';
    if (providers.length > 1) {
      const provDescs: Record<string, string> = {
        storacha: 'Filecoin + IPFS (decentralized)',
        local: 'Local encrypted storage',
      };
      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: '📦  Storage provider:',
        default: providerName,
        choices: providers.map(name => ({
          name: `${providerEmoji(name)}  ${BOLD(name)}  ${DIM(provDescs[name] || name)}${name === providerName ? ACCENT(' ★') : ''}`,
          value: name, short: name,
        })),
        loop: false,
      }]);
      providerName = selected;
    }

    const provider = getProvider(providerName);
    const provCheck = await provider.check();
    if (!provCheck.ok) {
      uiError(provCheck.error!);
      return;
    }

    // Read file
    const absPath = path.resolve(filePath);
    const fileName = path.basename(absPath);
    const fileBuffer = fs.readFileSync(absPath);

    // Flow display
    console.log('');
    console.log(`  ${BOLD(fileName)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key.name)} ${ACCENT('→')} ${providerEmoji(providerName)} ${BOLD(providerName)}`);
    sep();

    // Encrypt
    const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
    if (session.mode === 'web2') await restoreWeb2Session(session);

    spinner.text = `Encrypting ${BOLD(fileName)} ${DIM(`(${formatBytes(fileBuffer.byteLength)})`)}...`;
    const { encryptedBlob } = await encryptFileWeb2(key.secretId, fileBuffer, fileName, (pct) => {
      spinner.text = `Encrypting... ${pct}%`;
    });
    spinner.succeed(`Encrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

    // Upload
    const uploadSpinner = ora({ text: `Uploading to ${BOLD(providerName)}...`, indent: 2 }).start();
    const blobBuffer = Buffer.from(await encryptedBlob.arrayBuffer());
    const cid = await provider.upload(blobBuffer, fileName);
    uploadSpinner.succeed(`Stored on ${BOLD(providerName)}`);

    // Save
    const fileId = crypto.randomUUID();
    store.files.push({
      id: fileId, vaultId: key.id, originalName: fileName,
      originalSize: fileBuffer.byteLength, encryptedCid: cid,
      provider: providerName, ciferJobId: '', uploadedAt: new Date().toISOString(),
    });
    saveStore(store);

    console.log('');
    success(`${BOLD(fileName)} pushed`);
    console.log(`    ${DIM('Key:')}      ${ACCENT('⚷')} ${key.name}`);
    console.log(`    ${DIM('Provider:')} ${providerEmoji(providerName)} ${providerName}`);
    console.log(`    ${DIM('CID:')}      ${CYAN(cid)}`);
  } catch (err: any) {
    uiError(err.message);
  }
}

// ─── Pull ───────────────────────────────────────────────
async function interactivePull() {
  try {
    const session = getSession();
    const store = loadStore();

    if (store.files.length === 0) {
      warn('No files in your vault yet.');
      return;
    }

    // Pick file
    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: '📥  Select file to pull:',
      choices: store.files.map(f => {
        const key = store.vaults.find(v => v.id === f.vaultId);
        const prov = f.provider || 'storacha';
        return {
          name: `${providerEmoji(prov)} ${BOLD(f.originalName)}  ${DIM(formatBytes(f.originalSize))}  ${ACCENT('⚷')} ${key?.name || '?'}  ${DIM(f.uploadedAt.slice(0, 10))}`,
          value: f, short: f.originalName,
        };
      }),
      loop: false, pageSize: 10,
    }]);

    const fileRecord = selected;
    const key = store.vaults.find(v => v.id === fileRecord.vaultId);
    if (!key) { uiError('Key not found'); return; }

    const providerName = fileRecord.provider || 'storacha';
    const provider = getProvider(providerName);

    console.log('');
    console.log(`  ${providerEmoji(providerName)} ${BOLD(providerName)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key.name)} ${ACCENT('→')} ${BOLD(fileRecord.originalName)}`);
    sep();

    const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
    if (session.mode === 'web2') await restoreWeb2Session(session);

    spinner.text = `Downloading from ${BOLD(providerName)}...`;
    const encryptedBuffer = await provider.download(fileRecord.encryptedCid);
    spinner.succeed(`Downloaded ${DIM(`(${formatBytes(encryptedBuffer.byteLength)})`)}`);

    const decryptSpinner = ora({ text: 'Decrypting...', indent: 2 }).start();
    const decryptedBlob = await decryptFileWeb2(key.secretId, encryptedBuffer, fileRecord.originalName, (pct) => {
      decryptSpinner.text = `Decrypting... ${pct}%`;
    });
    decryptSpinner.succeed(`Decrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

    const saveTo = await promptSaveLocation();
    if (!saveTo) return;
    const outputPath = await resolveSavePath(saveTo, fileRecord.originalName);
    if (!outputPath) return;

    fs.writeFileSync(outputPath, Buffer.from(await decryptedBlob.arrayBuffer()));

    console.log('');
    success(`Saved to ${BOLD(outputPath)}`);
  } catch (err: any) {
    uiError(err.message);
  }
}

// ─── File Browser ───────────────────────────────────────
async function interactiveFileBrowser() {
  let browsing = true;

  while (browsing) {
    const store = loadStore();

    if (store.files.length === 0) {
      warn('No files in your vault yet.');
      return;
    }

    // Filter menu
    const session = store.session;
    const owner = session?.mode === 'web2' ? session.email : session?.walletAddress;
    const keys = store.vaults.filter(v => v.owner === owner);

    // Build filter choices
    const filterChoices: any[] = [
      { name: `${ACCENT('*')}  All files  ${DIM(`(${store.files.length})`)}`, value: 'all' },
    ];
    for (const k of keys) {
      const count = store.files.filter(f => f.vaultId === k.id).length;
      if (count > 0) {
        filterChoices.push({
          name: `${ACCENT('⚷')}  ${k.name}  ${DIM(`(${count} file${count !== 1 ? 's' : ''})`)}`,
          value: `key:${k.id}`,
        });
      }
    }
    for (const prov of listProviders()) {
      const count = store.files.filter(f => (f.provider || 'storacha') === prov).length;
      if (count > 0) {
        filterChoices.push({
          name: `${providerEmoji(prov)}  ${prov}  ${DIM(`(${count} file${count !== 1 ? 's' : ''})`)}`,
          value: `prov:${prov}`,
        });
      }
    }
    filterChoices.push({ name: `${DIM('←')}  Back`, value: 'back' });

    const { filter } = await inquirer.prompt([{
      type: 'list',
      name: 'filter',
      message: '📂  Browse by:',
      choices: filterChoices,
      loop: false,
    }]);

    if (filter === 'back') {
      browsing = false;
      continue;
    }

    // Apply filter
    let filteredFiles = store.files;
    let filterLabel = 'All files';
    if (filter.startsWith('key:')) {
      const keyId = filter.slice(4);
      filteredFiles = store.files.filter(f => f.vaultId === keyId);
      const k = store.vaults.find(v => v.id === keyId);
      filterLabel = `Key: ${k?.name || '?'}`;
    } else if (filter.startsWith('prov:')) {
      const prov = filter.slice(5);
      filteredFiles = store.files.filter(f => (f.provider || 'storacha') === prov);
      filterLabel = `Provider: ${prov}`;
    }

    // File selection loop
    let fileView = true;
    while (fileView && filteredFiles.length > 0) {
      const fileChoices = filteredFiles.map(f => {
        const key = store.vaults.find(v => v.id === f.vaultId);
        const prov = f.provider || 'storacha';
        return {
          name: `${providerEmoji(prov)} ${BOLD(f.originalName)}  ${DIM(formatBytes(f.originalSize))}  ${ACCENT('⚷')} ${key?.name || '?'}  ${DIM(f.uploadedAt.slice(0, 10))}`,
          value: f.id,
          short: f.originalName,
        };
      });
      fileChoices.push({ name: `${DIM('←')}  Back`, value: 'back', short: 'Back' });

      console.log(`\n  ${DIM(filterLabel)} ${DIM(`— ${filteredFiles.length} file${filteredFiles.length !== 1 ? 's' : ''}`)}`);

      const { fileId } = await inquirer.prompt([{
        type: 'list',
        name: 'fileId',
        message: '📄  Select a file:',
        choices: fileChoices,
        loop: false,
        pageSize: 15,
      }]);

      if (fileId === 'back') {
        fileView = false;
        continue;
      }

      // Show file detail + action menu
      await fileDetailMenu(fileId);

      // Refresh in case file was deleted
      const refreshed = loadStore();
      filteredFiles = filter === 'all'
        ? refreshed.files
        : filter.startsWith('key:')
          ? refreshed.files.filter(f => f.vaultId === filter.slice(4))
          : refreshed.files.filter(f => (f.provider || 'storacha') === filter.slice(5));
    }
  }
}

// ─── File Detail + Actions ──────────────────────────────
async function fileDetailMenu(fileId: string) {
  const store = loadStore();
  const f = store.files.find(x => x.id === fileId);
  if (!f) return;

  const key = store.vaults.find(v => v.id === f.vaultId);
  const prov = f.provider || 'storacha';
  const provider = getProvider(prov);

  // Show details
  console.log('');
  console.log(`  ${ACCENT('─── File Details ───')}`);
  console.log(`    ${DIM('Name:')}      ${BOLD(f.originalName)}`);
  console.log(`    ${DIM('Size:')}      ${formatBytes(f.originalSize)}`);
  console.log(`    ${DIM('Key:')}       ${ACCENT('⚷')} ${key?.name || '?'} ${DIM(`(secret #${key?.secretId || '?'})`)}`);
  console.log(`    ${DIM('Provider:')}  ${providerEmoji(prov)} ${prov}`);
  console.log(`    ${DIM('CID:')}       ${CYAN(f.encryptedCid)}`);
  console.log(`    ${DIM('URL:')}       ${DIM(provider.getUrl(f.encryptedCid))}`);
  console.log(`    ${DIM('Uploaded:')}  ${f.uploadedAt.slice(0, 10)}`);
  console.log(`    ${DIM('ID:')}        ${DIM(f.id)}`);

  const remoteUrl = provider.getUrl(f.encryptedCid);
  const isRemote = prov !== 'local';

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Action:',
    choices: [
      { name: `${ACCENT('↓')}  Pull (download & decrypt)`, value: 'pull' },
      ...(isRemote ? [{ name: `${ACCENT('🌐')} Open in browser        ${DIM('view encrypted on storage')}`, value: 'open' }] : []),
      { name: `${ACCENT('⎘')}  Copy CID`, value: 'copy-cid' },
      { name: `${chalk.red('×')}  Delete from vault`, value: 'delete' },
      { name: `${DIM('←')}  Back`, value: 'back' },
    ],
    loop: false,
  }]);

  if (action === 'pull') {
    await pullFileById(fileId);
  } else if (action === 'open') {
    await openInBrowser(remoteUrl);
  } else if (action === 'copy-cid') {
    await copyToClipboard(f.encryptedCid);
  } else if (action === 'delete') {
    await deleteFile(fileId);
  }
}

// ─── Pull file by ID ────────────────────────────────────
async function pullFileById(fileId: string) {
  try {
    const session = getSession();
    const store = loadStore();
    const f = store.files.find(x => x.id === fileId);
    if (!f) { uiError('File not found'); return; }

    const key = store.vaults.find(v => v.id === f.vaultId);
    if (!key) { uiError('Key not found'); return; }

    const providerName = f.provider || 'storacha';
    const provider = getProvider(providerName);

    console.log('');
    console.log(`  ${providerEmoji(providerName)} ${BOLD(providerName)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key.name)} ${ACCENT('→')} ${BOLD(f.originalName)}`);
    sep();

    const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
    if (session.mode === 'web2') await restoreWeb2Session(session);

    spinner.text = `Downloading from ${BOLD(providerName)}...`;
    const encryptedBuffer = await provider.download(f.encryptedCid);
    spinner.succeed(`Downloaded ${DIM(`(${formatBytes(encryptedBuffer.byteLength)})`)}`);

    const decryptSpinner = ora({ text: 'Decrypting...', indent: 2 }).start();
    const decryptedBlob = await decryptFileWeb2(key.secretId, encryptedBuffer, f.originalName, (pct) => {
      decryptSpinner.text = `Decrypting... ${pct}%`;
    });
    decryptSpinner.succeed(`Decrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

    const saveTo2 = await promptSaveLocation();
    if (!saveTo2) return;
    const outputPath = await resolveSavePath(saveTo2, f.originalName);
    if (!outputPath) return;

    fs.writeFileSync(outputPath, Buffer.from(await decryptedBlob.arrayBuffer()));

    console.log('');
    success(`Saved to ${BOLD(outputPath)}`);
  } catch (err: any) {
    uiError(err.message);
  }
}

// ─── Delete file ────────────────────────────────────────
async function deleteFile(fileId: string) {
  const store = loadStore();
  const idx = store.files.findIndex(f => f.id === fileId);
  if (idx === -1) { uiError('File not found'); return; }

  const f = store.files[idx];
  const prov = f.provider || 'storacha';

  // Confirm
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `${chalk.red('Delete')} ${BOLD(f.originalName)} from vault?`,
    default: false,
  }]);

  if (!confirm) return;

  // For local provider, also offer to delete the encrypted file on disk
  if (prov === 'local') {
    const { deleteLocal } = await inquirer.prompt([{
      type: 'confirm',
      name: 'deleteLocal',
      message: 'Also delete the encrypted file from disk?',
      default: false,
    }]);

    if (deleteLocal) {
      try {
        const provider = getProvider('local');
        const filePath = provider.getUrl(f.encryptedCid);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          info(`Deleted encrypted file from disk`);
        }
      } catch (err: any) {
        warn(`Could not delete local file: ${err.message}`);
      }
    }
  }

  // Remove from index
  store.files.splice(idx, 1);
  saveStore(store);

  if (prov !== 'local') {
    success(`${BOLD(f.originalName)} removed from vault index`);
    console.log(`    ${DIM(`Encrypted data still exists on ${prov} (CID: ${f.encryptedCid})`)}`);
  } else {
    success(`${BOLD(f.originalName)} deleted`);
  }
}

// ─── Key Create ─────────────────────────────────────────
async function interactiveKeyCreate() {
  try {
    const session = getSession();

    const { name } = await inquirer.prompt([{
      type: 'input',
      name: 'name',
      message: ACCENT('⚷') + '  Key name:',
      validate: (val: string) => val.trim() ? true : 'Name is required',
    }]);

    if (session.mode === 'web2') {
      const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
      await restoreWeb2Session(session);
      spinner.text = `Generating ${ACCENT('ML-KEM-768')} key pair...`;

      const secret = await createWeb2Secret();
      spinner.succeed('Key pair generated');

      const store = loadStore();
      const keyId = crypto.randomUUID();
      store.vaults.push({
        id: keyId, name: name.trim(), secretId: secret.secretId,
        authMode: 'web2', owner: session.email!, createdAt: new Date().toISOString(),
      });
      saveStore(store);

      console.log('');
      success(`Key ${ACCENT.bold(name.trim())} created`);
      console.log(`    ${DIM('Secret:')}  ${PURPLE(`#${secret.secretId}`)}`);
      console.log(`    ${DIM('Algo:')}    ${CYAN('ML-KEM-768')} + ${CYAN('AES-256-GCM')}`);
    } else {
      warn('Web3 key creation not yet implemented.');
    }
  } catch (err: any) {
    uiError(err.message);
  }
}

// ─── Key Manager ────────────────────────────────────────
async function interactiveKeyManage() {
  let managing = true;

  while (managing) {
    const store = loadStore();
    const session = store.session;
    if (!session) return;

    const owner = session.mode === 'web2' ? session.email : session.walletAddress;
    const keys = store.vaults.filter(v => v.owner === owner);

    if (keys.length === 0) {
      warn('No keys yet.');
      const { create } = await inquirer.prompt([{
        type: 'confirm', name: 'create',
        message: 'Create one now?', default: true,
      }]);
      if (create) await interactiveKeyCreate();
      return;
    }

    // Show table
    console.log('');
    const table = createTable(['', 'Name', 'Secret', 'Files', 'Size', 'Created']);
    for (const k of keys) {
      const fileCount = store.files.filter(f => f.vaultId === k.id).length;
      const totalSize = store.files.filter(f => f.vaultId === k.id).reduce((sum, f) => sum + f.originalSize, 0);
      table.push([
        ACCENT('⚷'), BOLD(k.name), PURPLE(`#${k.secretId}`),
        `${progressBar(fileCount, Math.max(fileCount, 5), 8)} ${DIM(String(fileCount))}`,
        DIM(formatBytes(totalSize)), DIM(k.createdAt.slice(0, 10)),
      ]);
    }
    console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));
    console.log(`  ${DIM(`${keys.length} key${keys.length !== 1 ? 's' : ''}  •  ML-KEM-768`)}`);

    // Select a key or action
    const choices: any[] = keys.map(k => {
      const fc = store.files.filter(f => f.vaultId === k.id).length;
      return {
        name: `${ACCENT('⚷')}  ${BOLD(k.name)}  ${DIM(`#${k.secretId}`)}  ${DIM(`(${fc} files)`)}`,
        value: `key:${k.id}`,
        short: k.name,
      };
    });
    choices.push(
      new inquirer.Separator(' '),
      { name: `${ACCENT('+')}  Create new key`, value: 'create' },
      { name: `${DIM('←')}  Back`, value: 'back' },
    );

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: ACCENT('⚷') + '  Select a key or action:',
      choices,
      loop: false,
      pageSize: 15,
    }]);

    if (selected === 'back') {
      managing = false;
    } else if (selected === 'create') {
      await interactiveKeyCreate();
    } else if (selected.startsWith('key:')) {
      await keyDetailMenu(selected.slice(4));
    }
  }
}

// ─── Key Detail + Actions ───────────────────────────────
async function keyDetailMenu(keyId: string) {
  const store = loadStore();
  const k = store.vaults.find(v => v.id === keyId);
  if (!k) return;

  const files = store.files.filter(f => f.vaultId === k.id);
  const totalSize = files.reduce((sum, f) => sum + f.originalSize, 0);

  console.log('');
  console.log(`  ${ACCENT('─── Key Details ───')}`);
  console.log(`    ${DIM('Name:')}      ${BOLD(k.name)}`);
  console.log(`    ${DIM('Secret:')}    ${PURPLE(`#${k.secretId}`)}`);
  console.log(`    ${DIM('Algo:')}      ${CYAN('ML-KEM-768')} + ${CYAN('AES-256-GCM')}`);
  console.log(`    ${DIM('Files:')}     ${files.length}`);
  console.log(`    ${DIM('Total:')}     ${formatBytes(totalSize)}`);
  console.log(`    ${DIM('Created:')}   ${k.createdAt.slice(0, 10)}`);
  console.log(`    ${DIM('ID:')}        ${DIM(k.id)}`);

  if (files.length > 0) {
    console.log(`\n    ${DIM('Files in this key:')}`);
    for (const f of files.slice(0, 5)) {
      const prov = f.provider || 'storacha';
      console.log(`      ${providerEmoji(prov)} ${f.originalName}  ${DIM(formatBytes(f.originalSize))}  ${DIM(f.uploadedAt.slice(0, 10))}`);
    }
    if (files.length > 5) {
      console.log(`      ${DIM(`... and ${files.length - 5} more`)}`);
    }
  }

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Action:',
    choices: [
      { name: `${ACCENT('↑')}  Push a file to this key`, value: 'push' },
      ...(files.length > 0 ? [{ name: `${ACCENT('◆')}  Browse files in this key`, value: 'browse' }] : []),
      { name: `${chalk.red('×')}  Delete this key`, value: 'delete' },
      { name: `${DIM('←')}  Back`, value: 'back' },
    ],
    loop: false,
  }]);

  if (action === 'push') {
    // Push with this key pre-selected
    await interactivePushWithKey(k);
  } else if (action === 'browse') {
    // Quick file list for this key
    for (const f of files) {
      const prov = f.provider || 'storacha';
      const { fileAction } = await inquirer.prompt([{
        type: 'list',
        name: 'fileAction',
        message: `${providerEmoji(prov)} ${BOLD(f.originalName)}  ${DIM(formatBytes(f.originalSize))}`,
        choices: [
          { name: `${ACCENT('↓')}  Pull`, value: 'pull' },
          { name: `${chalk.red('×')}  Delete`, value: 'delete' },
          { name: `${DIM('→')}  Next file`, value: 'next' },
          { name: `${DIM('←')}  Done`, value: 'done' },
        ],
        loop: false,
      }]);

      if (fileAction === 'pull') {
        await pullFileById(f.id);
      } else if (fileAction === 'delete') {
        await deleteFile(f.id);
      } else if (fileAction === 'done') {
        break;
      }
    }
  } else if (action === 'delete') {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `${chalk.red('Delete')} key ${BOLD(k.name)}?${files.length > 0 ? ` (${files.length} files removed from index)` : ''}`,
      default: false,
    }]);

    if (confirm) {
      const latest = loadStore();
      const idx = latest.vaults.findIndex(v => v.id === keyId);
      if (idx !== -1) {
        latest.vaults.splice(idx, 1);
        latest.files = latest.files.filter(f => f.vaultId !== keyId);
        saveStore(latest);
        success(`Key ${BOLD(k.name)} deleted`);
      }
    }
  }
}

// ─── Push with pre-selected key ─────────────────────────
async function interactivePushWithKey(key: any) {
  try {
    const session = getSession();
    const store = loadStore();

    const filePath = await pickFile('📄  Select file to encrypt:');
    if (!filePath) { info('Cancelled.'); return; }

    const providers = listProviders();
    let providerName = store.settings.defaultProvider || 'storacha';
    if (providers.length > 1) {
      const provDescs: Record<string, string> = {
        storacha: 'Filecoin + IPFS (decentralized)',
        local: 'Local encrypted storage',
      };
      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: '📦  Storage provider:',
        default: providerName,
        choices: providers.map(name => ({
          name: `${providerEmoji(name)}  ${BOLD(name)}  ${DIM(provDescs[name] || name)}${name === providerName ? ACCENT(' ★') : ''}`,
          value: name, short: name,
        })),
        loop: false,
      }]);
      providerName = selected;
    }

    const provider = getProvider(providerName);
    const provCheck = await provider.check();
    if (!provCheck.ok) { uiError(provCheck.error!); return; }

    const absPath = path.resolve(filePath);
    const fileName = path.basename(absPath);
    const fileBuffer = fs.readFileSync(absPath);

    console.log('');
    console.log(`  ${BOLD(fileName)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key.name)} ${ACCENT('→')} ${providerEmoji(providerName)} ${BOLD(providerName)}`);
    sep();

    const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
    if (session.mode === 'web2') await restoreWeb2Session(session);

    spinner.text = `Encrypting ${BOLD(fileName)} ${DIM(`(${formatBytes(fileBuffer.byteLength)})`)}...`;
    const { encryptedBlob } = await encryptFileWeb2(key.secretId, fileBuffer, fileName, (pct) => {
      spinner.text = `Encrypting... ${pct}%`;
    });
    spinner.succeed(`Encrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

    const uploadSpinner = ora({ text: `Uploading to ${BOLD(providerName)}...`, indent: 2 }).start();
    const blobBuffer = Buffer.from(await encryptedBlob.arrayBuffer());
    const cid = await provider.upload(blobBuffer, fileName);
    uploadSpinner.succeed(`Stored on ${BOLD(providerName)}`);

    const fileId = crypto.randomUUID();
    store.files.push({
      id: fileId, vaultId: key.id, originalName: fileName,
      originalSize: fileBuffer.byteLength, encryptedCid: cid,
      provider: providerName, ciferJobId: '', uploadedAt: new Date().toISOString(),
    });
    saveStore(store);

    console.log('');
    success(`${BOLD(fileName)} pushed`);
    console.log(`    ${DIM('Key:')}      ${ACCENT('⚷')} ${key.name}`);
    console.log(`    ${DIM('Provider:')} ${providerEmoji(providerName)} ${providerName}`);
    console.log(`    ${DIM('CID:')}      ${CYAN(cid)}`);
  } catch (err: any) {
    uiError(err.message);
  }
}

// ─── Providers ──────────────────────────────────────────
async function interactiveProviders() {
  const store = loadStore();
  const current = store.settings.defaultProvider || 'storacha';

  const provDescs: Record<string, string> = {
    storacha: 'Filecoin + IPFS (decentralized, permanent)',
    local: 'Local encrypted storage (offline)',
  };

  let back = false;
  while (!back) {
    // Show current providers
    console.log('');
    const table = createTable(['', 'Provider', 'Description', 'Files', '']);
    const latestStore = loadStore();
    const latestDefault = latestStore.settings.defaultProvider || 'storacha';

    for (const name of listProviders()) {
      const fileCount = latestStore.files.filter(f => (f.provider || 'storacha') === name).length;
      const isDefault = name === latestDefault;
      table.push([
        isDefault ? ACCENT('★') : ' ', BOLD(name),
        DIM(provDescs[name] || name), DIM(String(fileCount)),
        isDefault ? ACCENT('default') : '',
      ]);
    }
    console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: ACCENT('☁') + '  Provider actions:',
      choices: [
        { name: `${ACCENT('★')}  Set default provider`, value: 'set-default' },
        { name: `${ACCENT('?')}  Check provider status`, value: 'check' },
        { name: `${ACCENT('+')}  Setup Storacha        ${DIM('Filecoin setup guide')}`, value: 'setup-storacha' },
        { name: `${DIM('←')}  Back`, value: 'back' },
      ],
      loop: false,
    }]);

    switch (action) {
      case 'set-default': {
        const { provider } = await inquirer.prompt([{
          type: 'list',
          name: 'provider',
          message: 'Set default storage provider:',
          default: latestDefault,
          choices: listProviders().map(name => ({
            name: `${providerEmoji(name)}  ${BOLD(name)}  ${DIM(provDescs[name] || name)}`,
            value: name, short: name,
          })),
          loop: false,
        }]);
        const s = loadStore();
        s.settings.defaultProvider = provider;
        saveStore(s);
        success(`Default provider set to ${BOLD(provider)}`);
        break;
      }

      case 'check': {
        for (const name of listProviders()) {
          const p = getProvider(name);
          const spinner = ora({ text: `Checking ${BOLD(name)}...`, indent: 2 }).start();
          const result = await p.check();
          if (result.ok) {
            spinner.succeed(`${BOLD(name)} ${ACCENT('ready')}`);
          } else {
            spinner.fail(`${BOLD(name)} ${DIM(result.error || 'not ready')}`);
          }
        }
        break;
      }

      case 'setup-storacha': {
        console.log('');
        console.log(`  ${ACCENT('─── Storacha Setup Guide ───')}`);
        console.log('');
        console.log(`  ${BOLD('1.')} Install the CLI:`);
        console.log(`     ${CYAN('npm install -g @storacha/cli')}`);
        console.log('');
        console.log(`  ${BOLD('2.')} Login with your email:`);
        console.log(`     ${CYAN('storacha login you@email.com')}`);
        console.log('');
        console.log(`  ${BOLD('3.')} Create a storage space:`);
        console.log(`     ${CYAN('storacha space create my-vault')}`);
        console.log('');
        console.log(`  ${BOLD('4.')} Provision with free plan:`);
        console.log(`     ${CYAN('storacha space provision --customer you@email.com')}`);
        console.log('');
        console.log(`  ${DIM('After setup, urchin will auto-detect Storacha.')}`);
        break;
      }

      case 'back':
        back = true;
        break;
    }
  }
}

// ─── Settings ───────────────────────────────────────────
async function interactiveSettings() {
  const store = loadStore();

  console.log('');
  const table = createTable(['Setting', 'Value']);
  table.push(
    [DIM('Blackbox URL'), store.settings.blackboxUrl],
    [DIM('Chain ID'), String(store.settings.chainId)],
    [DIM('Default Provider'), store.settings.defaultProvider || 'storacha'],
    [DIM('Keys'), String(store.vaults.length)],
    [DIM('Files'), String(store.files.length)],
  );
  console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Edit a setting?',
    choices: [
      { name: `${ACCENT('⚙')}  Change Blackbox URL`, value: 'blackboxUrl' },
      { name: `${ACCENT('⚙')}  Change Chain ID`, value: 'chainId' },
      { name: `${ACCENT('⚙')}  Change Default Provider`, value: 'defaultProvider' },
      { name: `${DIM('←')}  Back`, value: 'back' },
    ],
    loop: false,
  }]);

  if (action === 'back') return;

  if (action === 'defaultProvider') {
    const { provider } = await inquirer.prompt([{
      type: 'list',
      name: 'provider',
      message: 'Select default provider:',
      default: store.settings.defaultProvider,
      choices: listProviders().map(name => ({
        name: `${providerEmoji(name)}  ${BOLD(name)}`,
        value: name,
      })),
      loop: false,
    }]);
    store.settings.defaultProvider = provider;
    saveStore(store);
    success(`Default provider → ${BOLD(provider)}`);
  } else {
    const current = action === 'blackboxUrl' ? store.settings.blackboxUrl : String(store.settings.chainId);
    const { value } = await inquirer.prompt([{
      type: 'input',
      name: 'value',
      message: `New value for ${action}:`,
      default: current,
    }]);

    if (action === 'blackboxUrl') {
      store.settings.blackboxUrl = value;
    } else if (action === 'chainId') {
      store.settings.chainId = parseInt(value, 10);
    }
    saveStore(store);
    success(`${action} → ${BOLD(value)}`);
  }
}

// ─── Whoami ─────────────────────────────────────────────
function interactiveWhoami() {
  const store = loadStore();
  if (!store.session) {
    warn('Not logged in.');
    return;
  }
  const s = store.session;
  console.log('');
  console.log(`    ${DIM('Mode:')}      ${s.mode}`);
  console.log(`    ${DIM('Email:')}     ${s.email || '—'}`);
  console.log(`    ${DIM('Wallet:')}    ${s.walletAddress || '—'}`);
  console.log(`    ${DIM('Principal:')} ${s.principalId || '—'}`);
}

// ─── Dashboard renderer ─────────────────────────────────
function showDashboard() {
  const store = loadStore();
  const s = store.session!;

  const defaultProv = store.settings.defaultProvider || 'storacha';
  const providerDescs: Record<string, string> = {
    storacha: 'Filecoin + IPFS',
    local: 'Local encrypted storage',
  };

  const owner = s.mode === 'web2' ? s.email : s.walletAddress;
  const keys = store.vaults.filter(v => v.owner === owner);

  const recentFiles = [...store.files]
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .slice(0, 5)
    .map(f => {
      const key = store.vaults.find(v => v.id === f.vaultId);
      return {
        name: f.originalName, size: f.originalSize,
        keyName: key?.name || '?', provider: f.provider || 'storacha',
        date: f.uploadedAt.slice(0, 10), cid: f.encryptedCid,
      };
    });

  renderDashboard({
    user: s.email || s.walletAddress || '—',
    mode: s.mode,
    providers: listProviders().map(name => ({
      name, desc: providerDescs[name] || name,
      fileCount: store.files.filter(f => (f.provider || 'storacha') === name).length,
      isDefault: name === defaultProv,
    })),
    keys: keys.map(k => ({
      name: k.name, secretId: k.secretId,
      fileCount: store.files.filter(f => f.vaultId === k.id).length,
      totalSize: store.files.filter(f => f.vaultId === k.id).reduce((sum, f) => sum + f.originalSize, 0),
    })),
    recentFiles,
  });
}
