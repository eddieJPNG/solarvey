/**
 * Hook `useFreighter` — integração com a extensão Freighter.
 *
 * Copiado do padrão recomendado pela skill `stellar-dev.dapp` →
 * "Wallet Integration" (a versão `@stellar/freighter-api` v6).
 */
import { useCallback, useEffect, useState } from "react";
import {
  getAddress,
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";

export interface FreighterState {
  /** Extensão instalada e acessível. */
  installed: boolean | null;
  /** Usuário autorizou acesso a uma conta. */
  connected: boolean;
  address: string | null;
  /** Nome da rede do Freighter (`TESTNET` / `PUBLIC`), não o passphrase. */
  network: string | null;
  loading: boolean;
  error: string | null;
  connect: () => Promise<string>;
  disconnect: () => void;
  sign: (xdr: string, networkPassphrase: string) => Promise<string>;
  /** Re-sincroniza instalação/conexão (útil após o usuário instalar a extensão). */
  refresh: () => Promise<void>;
}

export function useFreighter(): FreighterState {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkConnection = useCallback(async () => {
    const { isConnected: installedNow, error: installError } =
      await isConnected();
    setInstalled(!installError && installedNow);
    if (installError || !installedNow) {
      setConnected(false);
      setAddress(null);
      setNetwork(null);
      return;
    }

    // `getAddress` devolve address: "" até a extensão conceder acesso, então
    // um endereço não-vazio significa que já estamos autorizados.
    const { address: addr, error: addressError } = await getAddress();
    if (addressError || !addr) {
      setConnected(false);
      setAddress(null);
      setNetwork(null);
      return;
    }

    const { network: net, error: networkError } = await getNetwork();
    if (networkError) return;

    setConnected(true);
    setAddress(addr);
    setNetwork(net);
  }, []);

  useEffect(() => {
    // Sincroniza com um sistema externo (a extensão Freighter): o efeito
    // apenas dispara a leitura; todo `setState` acontece depois do `await`
    // das chamadas da extensão, nunca de forma síncrona.
    let cancelled = false;

    async function sync() {
      const { isConnected: installedNow, error: installError } =
        await isConnected();
      if (cancelled) return;
      setInstalled(!installError && installedNow);
      if (installError || !installedNow) {
        setConnected(false);
        setAddress(null);
        setNetwork(null);
        return;
      }

      // `getAddress` devolve address: "" até a extensão conceder acesso, então
      // um endereço não-vazio significa que já estamos autorizados.
      const { address: addr, error: addressError } = await getAddress();
      if (cancelled) return;
      if (addressError || !addr) {
        setConnected(false);
        setAddress(null);
        setNetwork(null);
        return;
      }

      const { network: net, error: networkError } = await getNetwork();
      if (cancelled || networkError) return;

      setConnected(true);
      setAddress(addr);
      setNetwork(net);
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { isConnected: installedNow, error: installError } =
        await isConnected();
      if (installError || !installedNow) {
        throw new Error("Freighter não instalada");
      }

      const { address: addr, error: accessError } = await requestAccess();
      if (accessError) throw new Error(accessError.message);

      const { network: net, error: networkError } = await getNetwork();
      if (networkError) throw new Error(networkError.message);

      setInstalled(true);
      setConnected(true);
      setAddress(addr);
      setNetwork(net);
      return addr;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setConnected(false);
    setAddress(null);
    setNetwork(null);
    setError(null);
  }, []);

  const sign = useCallback(
    async (xdr: string, networkPassphrase: string) => {
      if (!connected) throw new Error("Carteira não conectada");
      const { signedTxXdr, error: signError } = await signTransaction(xdr, {
        networkPassphrase,
      });
      if (signError) throw new Error(signError.message);
      return signedTxXdr;
    },
    [connected],
  );

  return {
    installed,
    connected,
    address,
    network,
    loading,
    error,
    connect,
    disconnect,
    sign,
    refresh: checkConnection,
  };
}
