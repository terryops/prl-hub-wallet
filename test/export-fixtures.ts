import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { xpub, derived, planTransaction, signTransaction, maxAmount, type UTXO } from "../src/wallet.ts";
const v = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const fixtures = v.cases.filter((c: {expected: string|null}) => c.expected).map((c: any) => {
  // The public native vector includes one legacy address-less external/0 input.
  // Attach its known fixture address, just as wallet.test.ts does; production
  // signing must continue to reject inputs with unverifiable ownership.
  const utxos = c.utxos.map((u: { address?: string }) => ({ ...u, address: u.address || v.addresses[0] }));
  const plan = planTransaction(v.xpub, "mainnet", c.to, BigInt(c.amount), c.fee, utxos);
  return { ...signTransaction(v.mnemonic, "mainnet", plan), network: "mainnet", utxos: plan.selected };
});
const pub = xpub(v.mnemonic, "testnet"), address = derived(pub, "testnet").address!;
const utxos = [{txid:"ab".repeat(32),vout:0,value:"100000000",address}];
const plan = planTransaction(pub, "testnet", derived(pub,"testnet",0,3).address!, 50000000n, 50000, utxos);
fixtures.push({ ...signTransaction(v.mnemonic, "testnet", plan), network:"testnet", utxos: plan.selected });
// Independently verify signatures for the repaired selection/recovery cases too.
for (const network of ["mainnet", "testnet"] as const) {
  const key = xpub(v.mnemonic, network), address = derived(key, network).address!, to = derived(key, network, 0, 3).address!;
  const good = { txid: "cd".repeat(32), vout: 0, value: "10006000", address }, dust = { txid: "ce".repeat(32), vout: 0, value: "330", address };
  const pool = Array.from({ length: 1001 }, (_, i) => ({ txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, value: "100000", address }));
  const change = [{ txid: "cf".repeat(32), vout: 0, value: "100000000", address: derived(key, network, 1, 70).address! }];
  const edgeCases: [UTXO[], bigint][] = [[ [good, dust], 10000000n ], [ [dust, good], maxAmount([dust, good], 50000) ], [pool, 1000000n], [change, 90000000n]];
  for (const [inputs, amount] of edgeCases) {
    const planned = planTransaction(key, network, to, amount, 50000, inputs);
    fixtures.push({ ...signTransaction(v.mnemonic, network, planned), network, utxos: planned.selected });
  }
}
mkdirSync("out/extension-qa", {recursive:true});
writeFileSync("out/extension-qa/signed-fixtures.json", JSON.stringify(fixtures));
console.log(`${fixtures.length} public signed fixtures exported`);
