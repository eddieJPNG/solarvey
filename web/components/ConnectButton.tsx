"use client";

import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { FREIGHTER_NETWORK, config, shortAddress } from "@/lib/stellar";
import styles from "./ConnectButton.module.css";

/**
 * Botão de conexão da carteira — checklist UX do SDD §8.
 *
 * Estados cobertos aqui: extensão ausente, rede errada (Freighter em outra
 * rede que a do app), falha de acesso e carregando durante a interação.
 * Assinatura de tx chega na Sprint 1 (`/create`), com os demais estados do §8.
 */
export function ConnectButton() {
  const {
    installed,
    connected,
    address,
    network,
    loading,
    error,
    connect,
    disconnect,
    refresh,
  } = useWallet();
  const [copied, setCopied] = useState(false);

  const networkMismatch =
    connected &&
    network !== null &&
    network.toUpperCase() !== FREIGHTER_NETWORK[config.network];

  async function handleConnect() {
    try {
      await connect();
    } catch {
      // O erro já está em `error` (estado do hook).
    }
  }

  async function handleCopy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (installed === false) {
    return (
      <div className={styles.wrap}>
        <p className={styles.hint}>
          Freighter não detectada.{" "}
          <a
            href="https://freighter.app/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Instalar a extensão
          </a>{" "}
          e recarregar a página.
        </p>
        <button
          type="button"
          className={styles.button}
          onClick={() => void refresh()}
        >
          Já instalei — verificar de novo
        </button>
      </div>
    );
  }

  if (!connected || !address) {
    return (
      <div className={styles.wrap}>
        <button
          type="button"
          className={styles.button}
          onClick={() => void handleConnect()}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? "Conectando…" : "Conectar Freighter"}
        </button>
        {installed === null && (
          <p className={styles.hint}>Verificando a carteira…</p>
        )}
        {error && (
          <p className={`${styles.hint} ${styles.error}`} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.account}>
        <button
          type="button"
          className={styles.address}
          onClick={() => void handleCopy(address)}
          title="Clicar para copiar o endereço"
        >
          <span className={styles.dot} aria-hidden="true" />
          {shortAddress(address)}
        </button>
        <span className={styles.network}>{network ?? "—"}</span>
        <button type="button" className={styles.link} onClick={disconnect}>
          Desconectar
        </button>
      </div>
      {copied && <p className={styles.hint}>Endereço copiado.</p>}
      {networkMismatch && (
        <p className={`${styles.hint} ${styles.error}`} role="alert">
          Rede divergente: a carteira está em <strong>{network}</strong> e o app
          em <strong>{config.network}</strong>. Troque a rede na Freighter.
        </p>
      )}
    </div>
  );
}
