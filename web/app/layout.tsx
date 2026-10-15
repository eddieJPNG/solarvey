import type { Metadata } from "next";
import { WalletProvider } from "@/components/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solarvey — pesquisas pagas com escrow verificável",
  description:
    "Crie uma pesquisa, financie um escrow em XLM e pague cada resposta. " +
    "Resultados auditáveis com raiz de Merkle e provas de inclusão.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
