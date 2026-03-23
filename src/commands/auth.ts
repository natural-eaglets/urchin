import { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { loadStore, saveStore } from '../lib/store.js';
import { registerWeb2, verifyWeb2, loginWeb2 } from '../lib/cifer.js';
import { header, kv, success, error as uiError, warn, ACCENT, DIM, BOLD } from '../lib/ui.js';

export function registerAuthCommands(program: Command) {
  // ─── Register ───────────────────────────────────────────
  program
    .command('register')
    .description('Create a new CIFER web2 account')
    .action(async () => {
      try {
        header('Register');

        const { email, password } = await inquirer.prompt([
          { type: 'input', name: 'email', message: 'Email:' },
          { type: 'password', name: 'password', message: 'Password:', mask: '●' },
        ]);

        const spinner = ora({ text: 'Registering...', indent: 2 }).start();
        await registerWeb2(email, password);
        spinner.succeed('Registration started');

        warn('Check your email for the verification code.');

        const { otp } = await inquirer.prompt([
          { type: 'input', name: 'otp', message: 'Verification code:' },
        ]);

        const verifySpinner = ora({ text: 'Verifying...', indent: 2 }).start();
        await verifyWeb2(email, otp);
        verifySpinner.succeed('Email verified');

        const loginSpinner = ora({ text: 'Logging in...', indent: 2 }).start();
        const session = await loginWeb2(email, password);
        loginSpinner.succeed('Logged in');

        const store = loadStore();
        store.session = {
          mode: 'web2',
          email,
          principalId: session.principalId,
          ed25519PrivateKey: session.ed25519PrivateKey,
          ed25519PublicKey: session.ed25519PublicKey,
        };
        saveStore(store);

        console.log('');
        success(`Account created and logged in as ${ACCENT(email)}`);
        console.log('');
      } catch (err: any) {
        uiError(err.message);
        process.exit(1);
      }
    });

  // ─── Login ──────────────────────────────────────────────
  program
    .command('login')
    .description('Log in to your CIFER account')
    .action(async () => {
      try {
        header('Login');

        const { email, password } = await inquirer.prompt([
          { type: 'input', name: 'email', message: 'Email:' },
          { type: 'password', name: 'password', message: 'Password:', mask: '●' },
        ]);

        const spinner = ora({ text: 'Logging in...', indent: 2 }).start();
        const session = await loginWeb2(email, password);
        spinner.succeed('Logged in');

        const store = loadStore();
        store.session = {
          mode: 'web2',
          email,
          principalId: session.principalId,
          ed25519PrivateKey: session.ed25519PrivateKey,
          ed25519PublicKey: session.ed25519PublicKey,
        };
        saveStore(store);

        console.log('');
        success(`Logged in as ${ACCENT(email)}`);
        console.log('');
      } catch (err: any) {
        uiError(err.message);
        process.exit(1);
      }
    });

  // ─── Logout ─────────────────────────────────────────────
  program
    .command('logout')
    .description('Log out and clear session')
    .action(() => {
      const store = loadStore();
      store.session = null;
      saveStore(store);
      success('Logged out');
      console.log('');
    });

  // ─── Whoami ─────────────────────────────────────────────
  program
    .command('whoami')
    .description('Show current user')
    .action(() => {
      const store = loadStore();
      if (!store.session) {
        warn('Not logged in. Run: urchin login');
        return;
      }
      const s = store.session;
      header('Session');
      kv('Mode', s.mode);
      kv('Email', s.email || '—');
      kv('Wallet', s.walletAddress || '—');
      kv('Principal', s.principalId || '—');
      console.log('');
    });
}
