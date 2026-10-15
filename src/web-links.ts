import { isAddress, type Network } from "./wallet.ts";
export function webLink(page: "workers" | "wallet", address: string, network: Network) {
  const addr = address.trim().toLowerCase();
  if (network !== "mainnet" || !isAddress(addr, "mainnet")) return undefined;
  // Keep the address in the fragment. The initial page request has no query/body.
  return `https://pearlhub.net/#${page}?${new URLSearchParams({ addr })}`;
}
