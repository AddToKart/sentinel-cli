/**
 * Secret encryption for API keys at rest.
 * Uses AES-256-GCM with a machine-local key stored in ~/.sentinel/.key
 *
 * This provides defense-in-depth:
 * - Plaintext keys never touch disk
 * - Accidental git commit of .sentinel.json does not leak keys
 * - Backup files do not contain raw keys
 *
 * The encryption key file (~/.sentinel/.key) is created with 0o600 permissions.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SENTINEL_DIR = path.join(os.homedir(), '.sentinel');
const KEY_FILE = path.join(SENTINEL_DIR, '.key');
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits
const TAG_LENGTH = 16; // 128 bits
const SALT = 'sentinel-v1'; // static salt for key derivation path

/**
 * Tags a value as encrypted so we can distinguish encrypted from plaintext.
 * Encrypted values are stored as: `$enc:<base64-iv>:<base64-tag>:<base64-ciphertext>`
 */
const ENC_PREFIX = '$enc:';

function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/**
 * Get or create the machine-local encryption key.
 * The key is derived from a randomly generated secret stored in ~/.sentinel/.key.
 * If the key file does not exist, it is generated with 0o600 permissions.
 */
function getOrCreateEncryptionKey(): Buffer {
  // Ensure directory exists
  fs.mkdirSync(SENTINEL_DIR, { recursive: true });

  if (fs.existsSync(KEY_FILE)) {
    try {
      const keyData = fs.readFileSync(KEY_FILE);
      if (keyData.length === KEY_LENGTH) return keyData;
    } catch {
      // Fall through to regenerate
    }
  }

  // Generate new key
  const newKey = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(KEY_FILE, newKey, { mode: 0o600 });
  // On Windows, mode is ignored, but we try
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows may not support chmod */ }
  return newKey;
}

/**
 * Encrypt a plaintext string (API key, token).
 * Returns an encrypted string with format: `$enc:<base64-iv>:<base64-tag>:<base64-ciphertext>`
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  // Don't re-encrypt already encrypted values
  if (isEncrypted(plaintext)) return plaintext;

  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt an encrypted secret string.
 * Accepts format: `$enc:<base64-iv>:<base64-tag>:<base64-ciphertext>`
 * Returns plaintext, or the original value if not encrypted.
 */
export function decryptSecret(encryptedValue: string): string {
  if (!encryptedValue || !isEncrypted(encryptedValue)) return encryptedValue;

  try {
    const key = getOrCreateEncryptionKey();
    const stripped = encryptedValue.slice(ENC_PREFIX.length);
    const parts = stripped.split(':');
    if (parts.length !== 3) return encryptedValue; // malformed, return as-is

    const [ivBase64, tagBase64, ciphertextBase64] = parts;
    const iv = Buffer.from(ivBase64!, 'base64');
    const tag = Buffer.from(tagBase64!, 'base64');
    const ciphertext = ciphertextBase64!;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch {
    // If decryption fails, return as-is (might not be encrypted, or key is corrupt)
    return encryptedValue;
  }
}

/**
 * Check if the encryption infrastructure is set up.
 */
export function isEncryptionReady(): boolean {
  return fs.existsSync(KEY_FILE) && fs.statSync(KEY_FILE).size === KEY_LENGTH;
}

/**
 * Wipe the encryption key (for security cleanup).
 */
export function wipeEncryptionKey(): void {
  try {
    if (fs.existsSync(KEY_FILE)) {
      // Overwrite with random data before deletion
      const size = fs.statSync(KEY_FILE).size;
      fs.writeFileSync(KEY_FILE, crypto.randomBytes(size));
      fs.unlinkSync(KEY_FILE);
    }
  } catch { /* best effort */ }
}
