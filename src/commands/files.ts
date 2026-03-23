import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { fileSelector, ItemType } from 'inquirer-file-selector';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadStore, saveStore, getSession, type StoredFile } from '../lib/store.js';
import { restoreWeb2Session, encryptFileWeb2, decryptFileWeb2 } from '../lib/cifer.js';
import { getProvider, listProviders } from '../lib/storage.js';
import {
  header, success, error as uiError, warn, info,
  formatBytes, step, flowArrow, sep, createTable,
  providerEmoji, ACCENT, DIM, BOLD, CYAN, PURPLE,
} from '../lib/ui.js';

// ─── Interactive prompts with arrow keys ────────────────

async function pickKey(store: ReturnType<typeof loadStore>, session: ReturnType<typeof getSession>) {
  const owner = session.mode === 'web2' ? session.email : session.walletAddress;
  const keys = store.vaults.filter(v => v.owner === owner);

  if (keys.length === 0) {
    uiError('No keys found. Create one first:');
    console.log(`    ${ACCENT('urchin key create <name>')}\n`);
    process.exit(1);
  }

  if (keys.length === 1) return keys[0];

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: ACCENT('⚷') + '  Select encryption key:',
    choices: keys.map(k => {
      const fileCount = store.files.filter(f => f.vaultId === k.id).length;
      return {
        name: `${ACCENT('⚷')} ${BOLD(k.name)}  ${DIM(`secret #${k.secretId}`)}  ${DIM(`(${fileCount} files)`)}`,
        value: k,
        short: k.name,
      };
    }),
    loop: false,
  }]);

  return selected;
}

async function pickProvider(store: ReturnType<typeof loadStore>) {
  const providers = listProviders();
  const defaultProv = store.settings.defaultProvider || 'storacha';

  const provDescs: Record<string, string> = {
    storacha: 'Filecoin + IPFS (decentralized)',
    local: 'Local encrypted storage',
  };

  if (providers.length === 1) return providers[0];

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '📦  Select storage provider:',
    default: defaultProv,
    choices: providers.map(name => ({
      name: `${providerEmoji(name)}  ${BOLD(name)}  ${DIM(provDescs[name] || name)}${name === defaultProv ? ACCENT(' ★') : ''}`,
      value: name,
      short: name,
    })),
    loop: false,
  }]);

  return selected;
}

async function pickFile(store: ReturnType<typeof loadStore>, label = 'Select file:') {
  if (store.files.length === 0) {
    uiError('No files in your vault. Push one first:');
    console.log(`    ${ACCENT('urchin push <file>')}\n`);
    process.exit(1);
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: label,
    choices: store.files.map(f => {
      const key = store.vaults.find(v => v.id === f.vaultId);
      const prov = f.provider || 'storacha';
      return {
        name: `${providerEmoji(prov)} ${BOLD(f.originalName)}  ${DIM(formatBytes(f.originalSize))}  ${ACCENT('⚷')} ${key?.name || '?'}  ${DIM(f.uploadedAt.slice(0, 10))}`,
        value: f,
        short: f.originalName,
      };
    }),
    loop: false,
    pageSize: 10,
  }]);

  return selected as StoredFile;
}

// ─── Register file commands ─────────────────────────────

export function registerFileCommands(program: Command) {
  const file = program.command('file').description('Encrypt, upload, download & decrypt files');

  // ─── Push (Encrypt & Upload) ────────────────────────────
  file
    .command('push')
    .description('Encrypt a file and upload to storage')
    .argument('[file-path]', 'Path to file (interactive if omitted)')
    .option('-k, --key <name>', 'Encryption key name or ID')
    .option('-p, --provider <name>', 'Storage provider (storacha, local)')
    .action(async (filePath: string | undefined, opts: { key?: string; provider?: string }) => {
      try {
        const session = getSession();
        const store = loadStore();

        // Interactive file browser if not provided
        if (!filePath) {
          const selected = await fileSelector({
            message: '📄  Select file to encrypt:',
            basePath: process.cwd(),
            type: ItemType.File,
            pageSize: 15,
            allowCancel: true,
            filter: (item) => {
              const name = path.basename(item.path);
              if (name.startsWith('.') && name !== '..') return false;
              if (name === 'node_modules' || name === 'dist') return false;
              return true;
            },
            theme: {
              style: {
                file: (text: string) => ACCENT(text),
                directory: (text: string) => chalk.hex('#00D4FF').bold(text + '/'),
                currentDir: (text: string) => chalk.white.bold(text),
                help: () => chalk.dim('  ↑↓ navigate  → enter folder  ← go back  ⏎ confirm  esc cancel'),
              },
              prefix: {
                file: '  📄 ',
                directory: '  📂 ',
                currentDir: '  📍 ',
              },
            } as any,
          });
          if (!selected) {
            console.log(chalk.dim('  Cancelled.'));
            return;
          }
          filePath = selected.path;
        }

        // Interactive key selection
        const owner = session.mode === 'web2' ? session.email : session.walletAddress;
        let key;
        if (opts.key) {
          key = store.vaults.find(v => v.name === opts.key || v.id === opts.key);
          if (!key) {
            uiError(`Key not found: ${opts.key}`);
            process.exit(1);
          }
        } else {
          const userKeys = store.vaults.filter(v => v.owner === owner);
          if (userKeys.length > 1) {
            key = await pickKey(store, session);
          } else {
            key = userKeys[0];
          }
          if (!key) {
            uiError('No key found. Create one first: urchin key create');
            process.exit(1);
          }
        }

        // Interactive provider selection
        let providerName: string;
        if (opts.provider) {
          providerName = opts.provider;
        } else if (listProviders().length > 1 && !opts.provider) {
          providerName = await pickProvider(store);
        } else {
          providerName = store.settings.defaultProvider || 'storacha';
        }

        const provider = getProvider(providerName);

        // Check provider is ready
        const provCheck = await provider.check();
        if (!provCheck.ok) {
          uiError(provCheck.error!);
          if (providerName === 'storacha') {
            console.log(DIM('\n    Setup Storacha:'));
            console.log(DIM('      npm i -g @storacha/cli'));
            console.log(DIM('      storacha login your@email.com'));
            console.log(DIM('      storacha space create my-vault\n'));
          }
          process.exit(1);
        }

        // Read file
        const absPath = path.resolve(filePath!);
        if (!fs.existsSync(absPath)) {
          uiError(`File not found: ${absPath}`);
          process.exit(1);
        }
        const fileName = path.basename(absPath);
        const fileBuffer = fs.readFileSync(absPath);
        const fileSize = fileBuffer.byteLength;

        // Display flow
        console.log('');
        flowArrow(fileName, key.name, providerName);
        sep();

        // Step 1: Restore session
        const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
        if (session.mode === 'web2') {
          await restoreWeb2Session(session);
        }

        // Step 2: Encrypt
        spinner.text = `Encrypting ${BOLD(fileName)} ${DIM(`(${formatBytes(fileSize)})`)}...`;
        const { encryptedBlob } = await encryptFileWeb2(
          key.secretId,
          fileBuffer,
          fileName,
          (pct) => { spinner.text = `Encrypting... ${pct}%`; }
        );
        spinner.succeed(`Encrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

        // Step 3: Upload
        const uploadSpinner = ora({ text: `Uploading to ${BOLD(providerName)}...`, indent: 2 }).start();
        const blobBuffer = Buffer.from(await encryptedBlob.arrayBuffer());
        const cid = await provider.upload(blobBuffer, fileName);
        uploadSpinner.succeed(`Stored on ${BOLD(providerName)}`);

        // Step 4: Save to index
        const fileId = crypto.randomUUID();
        store.files.push({
          id: fileId,
          vaultId: key.id,
          originalName: fileName,
          originalSize: fileSize,
          encryptedCid: cid,
          provider: providerName,
          ciferJobId: '',
          uploadedAt: new Date().toISOString(),
        });
        saveStore(store);

        // Result
        console.log('');
        success(`${BOLD(fileName)} pushed successfully`);
        console.log(`    ${DIM('Key:')}      ${ACCENT('⚷')} ${key.name}`);
        console.log(`    ${DIM('Provider:')} ${providerEmoji(providerName)} ${providerName}`);
        console.log(`    ${DIM('CID:')}      ${CYAN(cid)}`);
        console.log(`    ${DIM('URL:')}      ${DIM(provider.getUrl(cid))}`);
        console.log('');
      } catch (err: any) {
        uiError(err.message);
        process.exit(1);
      }
    });

  // ─── Pull (Download & Decrypt) ──────────────────────────
  file
    .command('pull')
    .description('Download from storage and decrypt')
    .argument('[name-or-id]', 'File name or ID (interactive if omitted)')
    .option('-o, --output <path>', 'Output path (default: current dir)')
    .action(async (nameOrId: string | undefined, opts: { output?: string }) => {
      try {
        const session = getSession();
        const store = loadStore();

        // Interactive file selection
        let fileRecord: StoredFile;
        if (nameOrId) {
          const found = store.files.find(f => f.id === nameOrId || f.originalName === nameOrId);
          if (!found) {
            uiError(`File not found: ${nameOrId}`);
            console.log(DIM('    Run "urchin ls" to see available files\n'));
            process.exit(1);
          }
          fileRecord = found;
        } else {
          fileRecord = await pickFile(store, '📥  Select file to pull:');
        }

        const key = store.vaults.find(v => v.id === fileRecord.vaultId);
        if (!key) {
          uiError('Key not found for this file');
          process.exit(1);
        }

        const providerName = fileRecord.provider || 'storacha';
        const provider = getProvider(providerName);

        // Display flow
        console.log('');
        console.log(
          `  ${providerEmoji(providerName)} ${BOLD(providerName)} ${ACCENT('→')} ${ACCENT('⚷')} ${BOLD(key.name)} ${ACCENT('→')} ${BOLD(fileRecord.originalName)}`
        );
        sep();

        // Step 1: Restore session
        const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
        if (session.mode === 'web2') {
          await restoreWeb2Session(session);
        }

        // Step 2: Download
        spinner.text = `Downloading from ${BOLD(providerName)}...`;
        const encryptedBuffer = await provider.download(fileRecord.encryptedCid);
        spinner.succeed(`Downloaded ${DIM(`(${formatBytes(encryptedBuffer.byteLength)})`)}`);

        // Step 3: Decrypt
        const decryptSpinner = ora({ text: 'Decrypting...', indent: 2 }).start();
        const decryptedBlob = await decryptFileWeb2(
          key.secretId,
          encryptedBuffer,
          fileRecord.originalName,
          (pct) => { decryptSpinner.text = `Decrypting... ${pct}%`; }
        );
        decryptSpinner.succeed(`Decrypted with ${ACCENT('ML-KEM-768')} + ${ACCENT('AES-256-GCM')}`);

        // Step 4: Save
        const outputPath = opts.output
          ? path.resolve(opts.output)
          : path.resolve(fileRecord.originalName);

        const arrayBuffer = await decryptedBlob.arrayBuffer();
        fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));

        console.log('');
        success(`Saved to ${BOLD(outputPath)}`);
        console.log(`    ${DIM(`Size: ${formatBytes(fileRecord.originalSize)}`)}`);
        console.log('');
      } catch (err: any) {
        uiError(err.message);
        process.exit(1);
      }
    });

  // ─── List Files ───────────────────────────────────────────
  file
    .command('list')
    .alias('ls')
    .description('List encrypted files')
    .option('-k, --key <name>', 'Filter by key name or ID')
    .action((opts: { key?: string }) => {
      const store = loadStore();

      if (!store.session) {
        warn('Not logged in. Run: urchin login');
        return;
      }

      let files = store.files;

      if (opts.key) {
        const key = store.vaults.find(v => v.name === opts.key || v.id === opts.key);
        if (key) {
          files = files.filter(f => f.vaultId === key.id);
        } else {
          uiError(`Key not found: ${opts.key}`);
          process.exit(1);
        }
      }

      if (files.length === 0) {
        warn('No files yet. Push one with: urchin push <file>');
        return;
      }

      console.log('');
      const table = createTable(['', 'File', 'Size', 'Key', 'Provider', 'Date']);

      for (const f of files) {
        const key = store.vaults.find(v => v.id === f.vaultId);
        const prov = f.provider || 'storacha';
        table.push([
          providerEmoji(prov),
          BOLD(f.originalName),
          DIM(formatBytes(f.originalSize)),
          `${ACCENT('⚷')} ${key?.name || '?'}`,
          DIM(prov),
          DIM(f.uploadedAt.slice(0, 10)),
        ]);
      }

      console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));
      console.log(`\n  ${DIM(`${files.length} file${files.length !== 1 ? 's' : ''}`)}\n`);
    });

  // ─── Remove ───────────────────────────────────────────────
  file
    .command('rm')
    .description('Remove file from local index (keeps it on storage)')
    .argument('[name-or-id]', 'File name or ID (interactive if omitted)')
    .action(async (nameOrId: string | undefined) => {
      const store = loadStore();

      let idx: number;
      if (nameOrId) {
        idx = store.files.findIndex(f => f.id === nameOrId || f.originalName === nameOrId);
        if (idx === -1) {
          uiError(`File not found: ${nameOrId}`);
          process.exit(1);
        }
      } else {
        const selected = await pickFile(store, '🗑️   Select file to remove:');
        idx = store.files.findIndex(f => f.id === selected.id);
      }

      const file = store.files[idx];
      const prov = file.provider || 'storacha';
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Remove ${BOLD(file.originalName)} from index? ${DIM(`(still on ${prov})`)}`,
        default: false,
      }]);

      if (!confirm) return;

      store.files.splice(idx, 1);
      saveStore(store);
      success(`Removed ${BOLD(file.originalName)} from index`);
    });

  // ─── Providers ────────────────────────────────────────────
  file
    .command('providers')
    .description('List available storage providers')
    .action(async () => {
      const store = loadStore();
      const current = store.settings.defaultProvider || 'storacha';

      const provDescs: Record<string, string> = {
        storacha: 'Filecoin + IPFS (decentralized, permanent)',
        local: 'Local encrypted storage (offline)',
      };

      console.log('');
      const table = createTable(['', 'Provider', 'Description', 'Files', '']);

      for (const name of listProviders()) {
        const fileCount = store.files.filter(f => (f.provider || 'storacha') === name).length;
        const isDefault = name === current;
        table.push([
          isDefault ? ACCENT('★') : ' ',
          BOLD(name),
          DIM(provDescs[name] || name),
          DIM(String(fileCount)),
          isDefault ? ACCENT('default') : '',
        ]);
      }

      console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));
      console.log(`\n  ${DIM('Set default:')} ${ACCENT('urchin config set defaultProvider <name>')}\n`);
    });
}
