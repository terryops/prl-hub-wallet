import { test } from "node:test";
import assert from "node:assert/strict";
import { DONATION_ADDRESS, DONATION_PRESETS, donationAmount, canDonate, addressHalves } from "../src/donation.ts";
import { isAddress } from "../src/wallet.ts";
test("native donation address, presets, minimum and fixed two-line receipt", () => {
  assert.equal(isAddress(DONATION_ADDRESS, "mainnet"), true);
  assert.deepEqual(DONATION_PRESETS, ["5", "10", "20"]);
  assert.equal(donationAmount("1"), 100000000n);
  assert.throws(() => donationAmount("0.99999999"), /最少/);
  assert.throws(() => donationAmount("1.000000001"), /8/);
  assert.equal(addressHalves(DONATION_ADDRESS).length, 2);
  assert.equal(addressHalves(DONATION_ADDRESS).join(""), DONATION_ADDRESS);
});
test("donation entry is mainnet-only and hidden for primary or rotated developer address", () => {
  assert.equal(canDonate("testnet", "other", "other"), false);
  assert.equal(canDonate("mainnet", DONATION_ADDRESS, "other"), false);
  assert.equal(canDonate("mainnet", "other", DONATION_ADDRESS.toUpperCase()), false);
  assert.equal(canDonate("mainnet", "other", "other"), true);
});
