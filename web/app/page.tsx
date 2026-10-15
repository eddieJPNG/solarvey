import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { config } from "@/lib/stellar";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <span className={styles.brand}>Solarvey</span>
        <ConnectButton />
      </header>

      <section className={styles.hero}>
        <h1 className={styles.title}>
          Pesquisa paga, <em>resultado verificável</em>.
        </h1>
        <p className={styles.lede}>
          O criador financia um escrow em XLM, cada resposta vira um hash
          on-chain e o respondente reivindica a recompensa direto do contrato.
          Ao fechar, a raiz de Merkle torna o resultado auditável por qualquer
          pessoa.
        </p>

        <p className={styles.cta}>
          <Link className={styles.ctaLink} href="/create">
            Criar uma pesquisa →
          </Link>
        </p>

        <dl className={styles.meta}>
          <div>
            <dt>Rede</dt>
            <dd>{config.network}</dd>
          </div>
          <div>
            <dt>Contrato</dt>
            <dd className={styles.mono}>
              {config.contractId || "ainda não implantado"}
            </dd>
          </div>
          <div>
            <dt>Escopo</dt>
            <dd>Sprints 0–1</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
