import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

/** scrypt cost: ~128 MiB working set, deliberately slow (a few hundred ms) — this is a passphrase
 * key derivation, not a hash checked on every request. Never lowered without a real reason; never
 * raised so far it makes restore impractical on the owner's own machine. */
export const SCRYPT_N = 2 ** 17, SCRYPT_R = 8, SCRYPT_P = 1;
const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12, TAG_LENGTH = 16;

export function newSalt(): Buffer { return randomBytes(16); }

/** The passphrase itself, and the key derived from it, live only in memory for one request's
 * duration — never written to disk, never logged, never part of any manifest or error message.
 * A plain Promise wrapper (not node:util's promisify) so scrypt's options-object overload resolves
 * without TypeScript overload ambiguity. */
export function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

/** One self-contained envelope: nonce || authTag || ciphertext. AES-256-GCM authenticates the
 * whole plaintext, so a corrupted or mismatched-key envelope fails closed at decrypt time instead
 * of silently returning garbage bytes. */
export function encryptEnvelope(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptEnvelope(key: Buffer, envelope: Buffer): Buffer {
  if (envelope.length < NONCE_LENGTH + TAG_LENGTH) throw new Error('vault-envelope-too-short');
  const nonce = envelope.subarray(0, NONCE_LENGTH);
  const tag = envelope.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
  const ciphertext = envelope.subarray(NONCE_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
