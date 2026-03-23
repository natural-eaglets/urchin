import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import crypto from 'crypto';
import { loadStore, saveStore, getSession } from '../lib/store.js';
import { restoreWeb2Session, createWeb2Secret } from '../lib/cifer.js';
import {
  header, success, error as uiError, warn, info,
  formatBytes, createTable, progressBar,
  ACCENT, DIM, BOLD, CYAN, PURPLE,
} from '../lib/ui.js';

export function registerKeyCommands(program: Command) {
  const key = program.command('key').description('Manage CIFER encryption keys');

  // ─── Create Key ─────────────────────────────────────────
  key
    .command('create')
    .description('Create a new encryption key (ML-KEM-768 key pair)')
    .argument('[name]', 'Key name')
    .action(async (name?: string) => {
      try {
        const session = getSession();

        if (!name) {
          const answers = await inquirer.prompt([{
            type: 'input',
            name: 'name',
            message: ACCENT('⚷') + '  Key name:',
            validate: (val: string) => val.trim() ? true : 'Name is required',
          }]);
          name = answers.name.trim();
        }

        if (session.mode === 'web2') {
          const spinner = ora({ text: 'Connecting to CIFER...', indent: 2 }).start();
          await restoreWeb2Session(session);
          spinner.text = `Generating ${ACCENT('ML-KEM-768')} key pair...`;

          const secret = await createWeb2Secret();
          spinner.succeed(`Key pair generated`);

          const store = loadStore();
          const keyId = crypto.randomUUID();
          store.vaults.push({
            id: keyId,
            name: name!,
            secretId: secret.secretId,
            authMode: 'web2',
            owner: session.email!,
            createdAt: new Date().toISOString(),
          });
          saveStore(store);

          console.log('');
          success(`Key ${ACCENT.bold(name!)} created`);
          console.log(`    ${DIM('Secret:')}  ${PURPLE(`#${secret.secretId}`)}`);
          console.log(`    ${DIM('Algo:')}    ${CYAN('ML-KEM-768')} + ${CYAN('AES-256-GCM')}`);
          console.log(`    ${DIM('ID:')}      ${DIM(keyId)}`);
          console.log('');
        } else {
          warn('Web3 key creation not yet implemented.');
        }
      } catch (err: any) {
        uiError(err.message);
        process.exit(1);
      }
    });

  // ─── List Keys ──────────────────────────────────────────
  key
    .command('list')
    .alias('ls')
    .description('List all encryption keys')
    .action(() => {
      const store = loadStore();
      const session = store.session;

      if (!session) {
        warn('Not logged in. Run: urchin login');
        return;
      }

      const owner = session.mode === 'web2' ? session.email : session.walletAddress;
      const keys = store.vaults.filter(v => v.owner === owner);

      if (keys.length === 0) {
        warn('No keys yet. Create one:');
        console.log(`    ${ACCENT('urchin key create <name>')}\n`);
        return;
      }

      console.log('');
      const table = createTable(['', 'Name', 'Secret', 'Files', 'Size', 'Created']);

      for (const k of keys) {
        const fileCount = store.files.filter(f => f.vaultId === k.id).length;
        const totalSize = store.files
          .filter(f => f.vaultId === k.id)
          .reduce((sum, f) => sum + f.originalSize, 0);

        table.push([
          ACCENT('⚷'),
          BOLD(k.name),
          PURPLE(`#${k.secretId}`),
          `${progressBar(fileCount, Math.max(fileCount, 5), 8)} ${DIM(String(fileCount))}`,
          DIM(formatBytes(totalSize)),
          DIM(k.createdAt.slice(0, 10)),
        ]);
      }

      console.log(table.toString().split('\n').map(l => '  ' + l).join('\n'));
      console.log(`\n  ${DIM(`${keys.length} key${keys.length !== 1 ? 's' : ''}  •  ML-KEM-768`)}\n`);
    });

  // ─── Delete Key ─────────────────────────────────────────
  key
    .command('delete')
    .description('Delete a key (local record only — CIFER secret remains)')
    .argument('[name-or-id]', 'Key name or ID (interactive if omitted)')
    .action(async (nameOrId?: string) => {
      const store = loadStore();
      const session = store.session;

      if (!session) {
        warn('Not logged in. Run: urchin login');
        return;
      }

      let idx: number;
      if (nameOrId) {
        idx = store.vaults.findIndex(v => v.id === nameOrId || v.name === nameOrId);
        if (idx === -1) {
          uiError(`Key not found: ${nameOrId}`);
          process.exit(1);
        }
      } else {
        const owner = session.mode === 'web2' ? session.email : session.walletAddress;
        const keys = store.vaults.filter(v => v.owner === owner);
        if (keys.length === 0) {
          warn('No keys to delete.');
          return;
        }

        const { selected } = await inquirer.prompt([{
          type: 'list',
          name: 'selected',
          message: '🗑️   Select key to delete:',
          choices: keys.map(k => {
            const fileCount = store.files.filter(f => f.vaultId === k.id).length;
            return {
              name: `${ACCENT('⚷')} ${BOLD(k.name)}  ${DIM(`secret #${k.secretId}`)}  ${DIM(`(${fileCount} files)`)}`,
              value: k.id,
              short: k.name,
            };
          }),
          loop: false,
        }]);

        idx = store.vaults.findIndex(v => v.id === selected);
      }

      const vault = store.vaults[idx];
      const fileCount = store.files.filter(f => f.vaultId === vault.id).length;

      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete key ${BOLD(vault.name)}?${fileCount > 0 ? ` (${fileCount} files removed from index, data stays on storage)` : ''}`,
        default: false,
      }]);

      if (!confirm) {
        console.log(DIM('  Cancelled.\n'));
        return;
      }

      store.vaults.splice(idx, 1);
      store.files = store.files.filter(f => f.vaultId !== vault.id);
      saveStore(store);
      success(`Key ${BOLD(vault.name)} deleted`);
      console.log('');
    });
}
