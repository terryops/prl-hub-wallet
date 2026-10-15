import { base64 } from "@scure/base";
import type { VaultData } from "./wallet.ts";
export type Envelope = { version: 1; iterations: 600000; salt: string; iv: string; ciphertext: string };
const iterations = 600000;
const aad = new TextEncoder().encode("Pearl Hub Wallet / vault v1 / PBKDF2-SHA256-600000");
export async function keyFromPassword(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, 256));
}
const importAES = (key: Uint8Array) => crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
export async function seal(data: VaultData, key: Uint8Array, salt: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await importAES(key), plaintext);
    return { version: 1, iterations, salt, iv: base64.encode(iv), ciphertext: base64.encode(new Uint8Array(encrypted)) };
  } finally { plaintext.fill(0); }
}
export async function open(envelope: Envelope, key: Uint8Array): Promise<VaultData> {
  if (envelope.version !== 1 || envelope.iterations !== iterations || base64.decode(envelope.salt).length !== 16 || base64.decode(envelope.iv).length !== 12) throw new Error("钱包文件版本无效。");
  let plaintext: Uint8Array;
  try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64.decode(envelope.iv) as BufferSource, additionalData: aad }, await importAES(key), base64.decode(envelope.ciphertext) as BufferSource)); }
  catch { throw new Error("密码错误或钱包文件损坏。"); }
  try {
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    if (!Array.isArray(data.wallets) || !data.wallets.length || !["mainnet", "testnet"].includes(data.network) || !Array.isArray(data.pending)) throw new Error("钱包文件无效。");
    return data;
  } finally { plaintext.fill(0); }
}
export async function createVault(data: VaultData, password: string) {
  if (password.length < 10) throw new Error("解锁密码至少 10 个字符。");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await keyFromPassword(password, salt);
  return { envelope: await seal(data, key, base64.encode(salt)), key };
}
export const bytes64 = base64;
