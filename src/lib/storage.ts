/**
 * Storage provider abstraction.
 *
 * Supports multiple backends for uploading encrypted files:
 *   - storacha   (Filecoin/IPFS via Storacha CLI)
 *   - local      (save encrypted file to a local directory)
 *
 * Extensible: add ipfs-pinning, s3, etc. by implementing StorageProvider.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const exec = promisify(execFile);

// ─── Provider interface ──────────────────────────────────
export interface StorageProvider {
  name: string;
  upload(data: Buffer, fileName: string): Promise<string>;   // returns CID or identifier
  download(id: string): Promise<Buffer>;
  getUrl(id: string): string;
  check(): Promise<{ ok: boolean; error?: string }>;
}

// ─── Storacha (Filecoin/IPFS) ────────────────────────────
export class StorachaProvider implements StorageProvider {
  name = 'storacha';
  private gateway = 'https://storacha.link/ipfs';

  async check(): Promise<{ ok: boolean; error?: string }> {
    try {
      await exec('storacha', ['whoami']);
      return { ok: true };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: 'Storacha CLI not found. Install: npm i -g @storacha/cli' };
      }
      return { ok: false, error: `Storacha not ready: ${err.stderr || err.message}` };
    }
  }

  async upload(data: Buffer, fileName: string): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), 'cifer-vault');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const tmpFile = path.join(tmpDir, `${fileName}.cifer`);
    fs.writeFileSync(tmpFile, data);

    try {
      const { stdout } = await exec('storacha', ['up', tmpFile, '--no-wrap']);
      const cidMatch = stdout.match(/ipfs\/(baf[a-z0-9]+)/) || stdout.match(/(baf[a-z0-9]{50,})/);
      if (!cidMatch) throw new Error(`Could not parse CID from: ${stdout.trim()}`);
      return cidMatch[1];
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  async download(cid: string): Promise<Buffer> {
    const url = `${this.gateway}/${cid}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  getUrl(cid: string): string {
    return `${this.gateway}/${cid}`;
  }
}

// ─── Local filesystem storage ────────────────────────────
export class LocalProvider implements StorageProvider {
  name = 'local';
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir || path.join(os.homedir(), '.cifer-vault', 'encrypted');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  async check(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async upload(data: Buffer, fileName: string): Promise<string> {
    // Use a content-based hash as the "CID"
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const id = `local-${hash.slice(0, 16)}`;
    const filePath = path.join(this.dir, `${id}.cifer`);
    fs.writeFileSync(filePath, data);
    return id;
  }

  async download(id: string): Promise<Buffer> {
    const filePath = path.join(this.dir, `${id}.cifer`);
    if (!fs.existsSync(filePath)) throw new Error(`Local file not found: ${id}`);
    return fs.readFileSync(filePath);
  }

  getUrl(id: string): string {
    return path.join(this.dir, `${id}.cifer`);
  }
}

// ─── Registry ────────────────────────────────────────────
const providers: Record<string, () => StorageProvider> = {
  storacha: () => new StorachaProvider(),
  local: () => new LocalProvider(),
};

export function getProvider(name: string): StorageProvider {
  const factory = providers[name];
  if (!factory) throw new Error(`Unknown storage provider: ${name}. Available: ${Object.keys(providers).join(', ')}`);
  return factory();
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
