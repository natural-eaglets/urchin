import { Command } from 'commander';
import { loadStore, saveStore } from '../lib/store.js';
import { header, kv, success, error as uiError, DIM, ACCENT, BOLD } from '../lib/ui.js';
import { listProviders } from '../lib/storage.js';

export function registerConfigCommands(program: Command) {
  const config = program.command('config').description('View or update settings');

  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const store = loadStore();
      header('Configuration');
      kv('Blackbox URL', store.settings.blackboxUrl);
      kv('Chain ID', String(store.settings.chainId));
      kv('Default Provider', store.settings.defaultProvider || 'storacha');
      kv('Vaults', String(store.vaults.length));
      kv('Files', String(store.files.length));
      kv('Logged in', store.session
        ? `${store.session.mode} — ${store.session.email || store.session.walletAddress}`
        : 'No');
      console.log('');
    });

  config
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'Setting key')
    .argument('<value>', 'Value')
    .action((key: string, value: string) => {
      const store = loadStore();
      const validKeys: Record<string, (v: string) => void> = {
        blackboxUrl: (v) => { store.settings.blackboxUrl = v; },
        chainId: (v) => { store.settings.chainId = parseInt(v, 10); },
        defaultProvider: (v) => {
          const available = listProviders();
          if (!available.includes(v)) {
            uiError(`Unknown provider: ${v}. Available: ${available.join(', ')}`);
            process.exit(1);
          }
          store.settings.defaultProvider = v;
        },
      };

      const setter = validKeys[key];
      if (!setter) {
        uiError(`Unknown key: ${key}`);
        console.log(DIM(`    Valid keys: ${Object.keys(validKeys).join(', ')}\n`));
        process.exit(1);
      }

      setter(value);
      saveStore(store);
      success(`${key} = ${value}`);
      console.log('');
    });
}
