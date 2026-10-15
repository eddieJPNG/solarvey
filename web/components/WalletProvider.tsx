"use client";

/**
 * Contexto único da carteira.
 *
 * `useFreighter` lê da extensão; sem este provider cada componente teria a sua
 * própria cópia de `connected`/`address` e poderiam divergir na mesma tela.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useFreighter, type FreighterState } from "@/hooks/useFreighter";

const WalletContext = createContext<FreighterState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useFreighter();
  return (
    <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): FreighterState {
  const wallet = useContext(WalletContext);
  if (!wallet) {
    throw new Error("useWallet precisa estar dentro de <WalletProvider>.");
  }
  return wallet;
}
