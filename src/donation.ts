import { parseAmount, type Network } from "./wallet.ts";
export const DONATION_ADDRESS = "prl1pmkyxyht58rzhe7cj9ha7ncpm6r28x6g0htq93ffs5hsh7lqsxj7qw9pyjv";
export const DONATION_PRESETS = ["5", "10", "20"];
export function canDonate(network: Network, primary: string, current: string) {
  return network === "mainnet" && primary.toLowerCase() !== DONATION_ADDRESS && current.toLowerCase() !== DONATION_ADDRESS;
}
export function donationAmount(value: string) {
  const amount = parseAmount(value);
  if (amount < 100000000n) throw new Error("自定义金额最少 1 PRL。");
  return amount;
}
export function addressHalves(address: string) {
  const mid = Math.ceil(address.length / 2);
  return [address.slice(0, mid), address.slice(mid)];
}
