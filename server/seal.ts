// Bytes encrypted with a passphrase: the secrets file where there is no
// Keychain (config.ts), and what `tabellar move` writes (move.ts). The key is
// scrypt of the passphrase with a fresh salt; AES-256-GCM also tells a wrong
// passphrase or a changed file from the right one.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("tabellar sealed 1\n");
const HEAD = MAGIC.length + 16 + 12 + 16; // salt, nonce, tag

const keyOf = (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize("NFC"), salt, 32, { N: 2 ** 16, r: 8, p: 1, maxmem: 2 ** 27 });

export function seal(passphrase: string, bytes: Buffer): Buffer {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(passphrase, salt), nonce);
  const body = [c.update(bytes), c.final()];
  return Buffer.concat([MAGIC, salt, nonce, c.getAuthTag(), ...body]);
}

export function unseal(passphrase: string, sealed: Buffer, wrong: string): Buffer {
  if (sealed.length < HEAD || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("That is not a file Tabellar wrote.");
  const at = (from: number, n: number) => sealed.subarray(MAGIC.length + from, MAGIC.length + from + n);
  const d = createDecipheriv("aes-256-gcm", keyOf(passphrase, at(0, 16)), at(16, 12));
  d.setAuthTag(at(28, 16));
  try {
    return Buffer.concat([d.update(sealed.subarray(HEAD)), d.final()]);
  } catch {
    throw new Error(wrong);
  }
}
