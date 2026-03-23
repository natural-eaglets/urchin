/**
 * Local JSON file store for vault data.
 * Stored at ~/.cifer-vault/data.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const STORE_DIR = path.join(os.homedir(), '.cifer-vault');
const STORE_FILE = path.join(STORE_DIR, 'data.json');

export interface StoredSession {
  mode: 'web2' | 'web3';
  email?: string;
  principalId?: string;
  ed25519PrivateKey?: string;
  ed25519PublicKey?: string;
  walletAddress?: string;
  chainId?: number;
}

export interface StoredVault {
  id: string;
  name: string;
  secretId: number;
  authMode: 'web2' | 'web3';
  owner: string;
  createdAt: string;
}

export interface StoredFile {
  id: string;
  vaultId: string;
  originalName: string;
  originalSize: number;
  encryptedCid: string;
  provider: string;        // storacha | local | ...
  ciferJobId?: string;
  uploadedAt: string;
}

export interface StoreData {
  session: StoredSession | null;
  vaults: StoredVault[];
  files: StoredFile[];
  settings: {
    blackboxUrl: string;
    chainId: number;
    defaultProvider: string;  // default storage provider
  };
}

const DEFAULT_DATA: StoreData = {
  session: null,
  vaults: [],
  files: [],
  settings: {
    blackboxUrl: 'https://cifer-blackbox.ternoa.dev:3010',
    chainId: 752025,
    defaultProvider: 'storacha',
  },
};

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

export function loadStore(): StoreData {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { ...DEFAULT_DATA };
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    return { ...DEFAULT_DATA, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DATA };
  }
}

export function saveStore(data: StoreData): void {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

export function getSession(): StoredSession {
  const data = loadStore();
  if (!data.session) {
    throw new Error('Not logged in. Run: urchin login');
  }
  return data.session;
}
