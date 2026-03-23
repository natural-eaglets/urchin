/**
 * CIFER SDK wrapper — handles both web2 and web3 modes.
 *
 * Hybrid encryption approach:
 *   1. CIFER payload API (ML-KEM-768) encrypts a random AES-256 key
 *   2. File content is encrypted locally with AES-256-GCM
 *
 * This bypasses the /encrypt-file endpoint which doesn't support
 * web2 chain (-1) on the current blackbox server.
 */
import {
  createCiferSdk,
  web2,
  type SignerAdapter,
} from 'cifer-sdk';
import * as ed from '@noble/ed25519';
import crypto from 'crypto';
import { loadStore, type StoredSession } from './store.js';

let sdkInstance: Awaited<ReturnType<typeof createCiferSdk>> | null = null;
let currentSession: any = null;

export async function getSdk() {
  if (!sdkInstance) {
    const { settings } = loadStore();
    sdkInstance = await createCiferSdk({ blackboxUrl: settings.blackboxUrl });
  }
  return sdkInstance;
}

function getBlackboxUrl() {
  return loadStore().settings.blackboxUrl;
}

async function getReadClient() {
  const sdk = await getSdk();
  return sdk.readClient;
}

// ─── Web2 Auth ──────────────────────────────────────────

export async function registerWeb2(email: string, password: string) {
  const bbUrl = getBlackboxUrl();
  const reg = await web2.auth.register({ email, password, blackboxUrl: bbUrl });
  return reg;
}

export async function verifyWeb2(email: string, otp: string) {
  const bbUrl = getBlackboxUrl();
  await web2.auth.verifyEmail({ email, otp, blackboxUrl: bbUrl });
}

function makeEd25519Signer(privateKey: Uint8Array, publicKey: Uint8Array) {
  return {
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return ed.signAsync(message, privateKey);
    },
    getPublicKey(): Uint8Array {
      return publicKey;
    },
  };
}

export async function loginWeb2(email: string, password: string) {
  const sdk = await getSdk();
  const bbUrl = getBlackboxUrl();

  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const ed25519Signer = makeEd25519Signer(privateKey, publicKey);

  // Look up principal
  const principal = await (web2.principal as any).getByEmail(email, bbUrl);

  // Register Ed25519 key
  await web2.auth.registerKey({
    principalId: principal.principalId,
    password,
    ed25519Signer,
    blackboxUrl: bbUrl,
  });

  // Create a session (stateless approach)
  currentSession = await web2.session.createManagedSession({
    principalId: principal.principalId,
    ed25519Signer,
    blackboxUrl: bbUrl,
  });

  return {
    principalId: principal.principalId,
    ed25519PrivateKey: Buffer.from(privateKey).toString('hex'),
    ed25519PublicKey: Buffer.from(publicKey).toString('hex'),
  };
}

export async function restoreWeb2Session(session: StoredSession) {
  if (session.mode !== 'web2' || !session.ed25519PrivateKey || !session.principalId) {
    throw new Error('Invalid web2 session data');
  }

  const bbUrl = getBlackboxUrl();
  const privateKey = new Uint8Array(Buffer.from(session.ed25519PrivateKey, 'hex'));
  const publicKey = new Uint8Array(Buffer.from(session.ed25519PublicKey!, 'hex'));
  const ed25519Signer = makeEd25519Signer(privateKey, publicKey);

  currentSession = await web2.session.createManagedSession({
    principalId: session.principalId,
    ed25519Signer,
    blackboxUrl: bbUrl,
  });
}

function requireSession() {
  if (!currentSession) throw new Error('Not logged in. Run: urchin login');
  return currentSession;
}

// ─── Web2 Secret (Vault) Management ─────────────────────

export async function createWeb2Secret() {
  const session = requireSession();
  const bbUrl = getBlackboxUrl();
  return web2.secret.createSecret({ session, blackboxUrl: bbUrl });
}

export async function listWeb2Secrets() {
  const session = requireSession();
  const bbUrl = getBlackboxUrl();
  return web2.secret.listSecrets({ session, blackboxUrl: bbUrl });
}

// ─── Web2 File Encryption (hybrid: CIFER payload + local AES-256-GCM) ───
//
// The blackbox /encrypt-file endpoint doesn't support web2 chain (-1).
// Workaround: use the payload API to encrypt a random AES key via CIFER's
// ML-KEM-768, then encrypt the file locally with AES-256-GCM.
//
// Encrypted bundle format (.cifer.json):
// {
//   version: 1,
//   cifer: <hex>,              // ML-KEM ciphertext wrapping the AES key
//   encryptedKey: <hex>,       // AES key encrypted via CIFER payload API
//   iv: <hex>,                 // 12-byte AES-GCM nonce
//   authTag: <hex>,            // 16-byte AES-GCM auth tag
//   encryptedData: <base64>,   // AES-GCM encrypted file content
//   originalName: <string>,
//   originalSize: <number>,
// }

export interface EncryptedBundle {
  version: number;
  cifer: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  encryptedData: string;
  originalName: string;
  originalSize: number;
}

export async function encryptFileWeb2(
  secretId: number,
  fileBuffer: Buffer,
  fileName: string,
  onProgress?: (pct: number) => void
): Promise<{ encryptedBlob: Blob }> {
  const session = requireSession();
  const bbUrl = getBlackboxUrl();
  const readClient = await getReadClient();

  onProgress?.(10);

  // Step 1: Generate a random 256-bit AES key
  const aesKey = crypto.randomBytes(32);
  const aesKeyHex = aesKey.toString('hex');

  onProgress?.(20);

  // Step 2: Encrypt the AES key using CIFER payload API (ML-KEM-768)
  // This uses the web2 session and the /encrypt-payload endpoint
  const keyEncrypted = await web2.blackbox.payload.encryptPayload({
    session,
    secretId: BigInt(secretId),
    plaintext: aesKeyHex,
    blackboxUrl: bbUrl,
    readClient,
    outputFormat: 'hex',
  });

  onProgress?.(50);

  // Step 3: Encrypt the file locally with AES-256-GCM
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  onProgress?.(80);

  // Step 4: Bundle everything together
  const bundle: EncryptedBundle = {
    version: 1,
    cifer: keyEncrypted.cifer,
    encryptedKey: keyEncrypted.encryptedMessage,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    encryptedData: encrypted.toString('base64'),
    originalName: fileName,
    originalSize: fileBuffer.byteLength,
  };

  const bundleJson = JSON.stringify(bundle);
  const encryptedBlob = new Blob([new TextEncoder().encode(bundleJson)]);

  onProgress?.(100);

  return { encryptedBlob };
}

export async function decryptFileWeb2(
  secretId: number,
  fileBuffer: Buffer,
  _fileName: string,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  const session = requireSession();
  const bbUrl = getBlackboxUrl();
  const readClient = await getReadClient();

  onProgress?.(10);

  // Step 1: Parse the encrypted bundle
  const bundleJson = fileBuffer.toString('utf-8');
  let bundle: EncryptedBundle;
  try {
    bundle = JSON.parse(bundleJson);
  } catch {
    throw new Error('Invalid encrypted file format. Expected .cifer.json bundle.');
  }

  if (bundle.version !== 1) {
    throw new Error(`Unsupported bundle version: ${bundle.version}`);
  }

  onProgress?.(20);

  // Step 2: Decrypt the AES key using CIFER payload API
  const keyDecrypted = await web2.blackbox.payload.decryptPayload({
    session,
    secretId: BigInt(secretId),
    encryptedMessage: bundle.encryptedKey,
    cifer: bundle.cifer,
    blackboxUrl: bbUrl,
    readClient,
    inputFormat: 'hex',
  });

  onProgress?.(50);

  const aesKey = Buffer.from(keyDecrypted.decryptedMessage, 'hex');
  const iv = Buffer.from(bundle.iv, 'hex');
  const authTag = Buffer.from(bundle.authTag, 'hex');
  const encryptedData = Buffer.from(bundle.encryptedData, 'base64');

  // Step 3: Decrypt the file locally with AES-256-GCM
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  onProgress?.(100);

  return new Blob([decrypted]);
}
