/**
 * Configuração Stellar (SDD §3.1) — inicialização do SDK.
 *
 * Testnet é a rede dos sprints S1–S4 (decisão de mainnet é o gate S4).
 * Fonte: skill `stellar-dev.dapp` → "SDK Initialization".
 */
import { Horizon, Networks, rpc } from "@stellar/stellar-sdk";

export type Network = "testnet" | "mainnet";

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

function getConfig(network: Network) {
  switch (network) {
    case "testnet":
      return {
        horizonUrl: "https://horizon-testnet.stellar.org",
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase: Networks.TESTNET,
        friendbotUrl: "https://friendbot.stellar.org",
      };
    case "mainnet":
      return {
        horizonUrl: "https://horizon.stellar.org",
        rpcUrl: requireEnv("NEXT_PUBLIC_STELLAR_MAINNET_RPC_URL"),
        networkPassphrase: Networks.PUBLIC,
        friendbotUrl: null,
      };
    default:
      throw new Error(`Unknown network: ${network satisfies never}`);
  }
}

const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
  "testnet") as Network;

export const config = {
  network,
  ...getConfig(network),
  /**
   * Endereço do contrato `SolarveyEscrow` deployado (preenchido por
   * `scripts/deploy.sh`).
   */
  contractId: process.env.NEXT_PUBLIC_SOLARVEY_CONTRACT_ID ?? "",
  /**
   * SAC nativa do XLM da rede corrente — difere por rede, por isso não é
   * constante (ver README "Decisões" e `docs/adr/0001-reward-mechanism.md`).
   */
  nativeSac: process.env.NEXT_PUBLIC_NATIVE_SAC_CONTRACT ?? "",
} as const;

export const horizon = new Horizon.Server(config.horizonUrl);
export const sorobanRpc = new rpc.Server(config.rpcUrl);

/**
 * Nome que a Freighter devolve em `getNetwork()` para cada rede nossa.
 * Usado para detectar a divergência de rede antes de assinar (§8).
 */
export const FREIGHTER_NETWORK: Record<Network, string> = {
  testnet: "TESTNET",
  mainnet: "PUBLIC",
};

/** Link de inspeção da tx — fallback de UX caso o usuário desista da UI (§8). */
export function explorerTxUrl(hash: string): string {
  const segment = config.network === "mainnet" ? "public" : config.network;
  return `https://stellar.expert/explorer/${segment}/tx/${hash}`;
}

/** Link de inspeção do contrato. */
export function explorerContractUrl(contractId: string): string {
  const segment = config.network === "mainnet" ? "public" : config.network;
  return `https://stellar.expert/explorer/${segment}/contract/${contractId}`;
}

/** Endereço truncado para exibição: `GABC…XYZ1`. */
export function shortAddress(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
