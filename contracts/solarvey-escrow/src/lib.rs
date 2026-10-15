#![no_std]

// Solarvey — contrato `SolarveyEscrow`
// Especificação: docs/SDD-MVP.md §4 (§4.1 modelo, §4.2 TTL, §4.3 interface,
// §4.4 invariantes, §4.6 eventos, §4.7 erros).
//
// Assinaturas de §4.3 são reproduzidas literalmente (sem `Result`); os códigos de
// §4.7 sobem ao cliente tipados via `panic_with_error!`, que é o caminho
// recomendado pela skill stellar-dev.smart-contracts (panics "nus" viram erros
// opacos de host que o cliente não consegue casar).
//
// Desvios conscientes e documentados:
//  * `initialize` recebe também `token` (address da SAC do XLM). §4.3 declara só
//    `admin`, mas §4.4/§4.5 exigem "XLM nativo via SAC" e essa address difere
//    por rede (testnet CDLZFC3S… / mainnet CAS3J7GY…), logo não pode ser
//    constante. Sem ela `fund`/`claim`/`refund` não transferem nada.
//  * `DataKey` ganhou `Token` (acima) e `Claimed(u64, Address)` — §4.4 regra 3
//    manda marcar `claimed` em storage temporary "junto do `Response`", mas o
//    enum de §4.1 não o lista.
//  * `create_survey` recusa `deadline > agora + MAX_SURVEY_LIFETIME`. Consequência
//    direta de §4.2: o TTL de `Response` é `deadline − agora + folga` em
//    *temporary*, e estender temporary além de `max_entry_ttl` dá **trap**. Sem
//    esse teto, um deadline distante deixaria `Response` expirar antes do
//    deadline e quebraria o invariante 2 (double-submit).
//  * `fund`/`claim`/`refund`/`close` distinguem "escrow inexistente"
//    (`ERR_NOT_FUNDED`) de "escrow pequeno" (`ERR_INSUFFICIENT_ESCROW`) — §4.7
//    tem os dois códigos e §4.4 não diz qual função usa qual; esse é o reparto
//    que os torna ambos alcançáveis.
//  * `refund` **zera** `Escrow(id)` em vez de removê-lo, para que `fund` continue
//    bloqueado depois do reembolso (§4.4 regra 1: "uma vez por survey").
//
// Limites de TTL lidos de `stellar network settings --network testnet`
// (2026-10-12): max_entry_ttl 3_110_400 · min_persistent_ttl 120_960 ·
// min_temporary_ttl 720.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    token::TokenClient, Address, BytesN, Env,
};

/// 1 dia em ledgers (~5 s/ledger).
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// Piso de TTL das entries persistentes — §4.2: "30 dias, estendido por tx de
/// manutenção". `extend_ttl` só estende, nunca encurta.
pub const PERSISTENT_TTL: u32 = 30 * DAY_IN_LEDGERS;
/// Folga pós-`deadline` para que claims continuem possíveis (§4.4 regra 4).
pub const RESPONSE_GRACE: u32 = 30 * DAY_IN_LEDGERS;
/// Piso de TTL temporário da rede (`min_temporary_ttl`).
pub const MIN_TEMPORARY_TTL: u32 = 720;
/// Teto de entry TTL da rede (`max_entry_ttl`, ~180 dias).
pub const MAX_ENTRY_TTL: u32 = 3_110_400;
/// Teto seguro p/ temporary: `extend_ttl` tranpa acima de `max_entry_ttl - 1`.
pub const MAX_TEMPORARY_TTL: u32 = MAX_ENTRY_TTL - 1;
/// Vida máxima de uma pesquisa, para que `deadline − agora + folga` caiba no
/// teto de temporary.
pub const MAX_SURVEY_LIFETIME: u64 = MAX_TEMPORARY_TTL as u64 - RESPONSE_GRACE as u64;
/// 1 XLM = 10_000_000 stroops.
pub const STROOPS_PER_XLM: i128 = 10_000_000;

/// §4.7 — erros. Nomes preservados literalmente da tabela do SDD.
#[contracterror]
#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    ERR_NOT_AUTH = 1,
    ERR_CLOSED = 2,
    ERR_DEADLINE = 3,
    ERR_FULL = 4,
    ERR_ALREADY_RESPONDED = 5,
    ERR_NO_RESPONSE = 6,
    ERR_ALREADY_CLAIMED = 7,
    ERR_INSUFFICIENT_ESCROW = 8,
    ERR_NOT_FUNDED = 9,
    ERR_COUNT_MISMATCH = 10,
    ERR_BAD_STATE = 11,
}

/// §4.1 — chaves de storage (+ `Token`, `Claimed`; ver cabeçalho).
#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    NextId,
    Survey(u64),
    Escrow(u64),
    Response(u64, Address),
    Claimed(u64, Address),
}

/// `Open | Closed` (§4.1, `Survey.state`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum State {
    Open,
    Closed,
}

/// §4.1 — `Survey`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Survey {
    pub id: u64,
    pub owner: Address,
    /// Commit do JSON das perguntas.
    pub questions_hash: BytesN<32>,
    /// Stroops por resposta (§4.1).
    pub reward: i128,
    pub max_responses: u32,
    pub responded: u32,
    /// Ledger sequence de expiração (§4.1).
    pub deadline: u64,
    pub state: State,
    /// Zeros até `close()` (§4.1).
    pub merkle_root: BytesN<32>,
}

// ------------------------------------------------------- eventos (§4.6)
// O topic de nome é o próprio nome do struct em snake_case, então os topics
// batem com a tabela: ["survey_created", id], ["funded", id], ["response", id],
// ["claimed", id], ["closed", id], ["refunded", id].

#[contractevent]
pub struct SurveyCreated {
    #[topic]
    pub id: u64,
    pub owner: Address,
    pub questions_hash: BytesN<32>,
    pub reward: i128,
    pub max_responses: u32,
    pub deadline: u64,
}

#[contractevent]
pub struct Funded {
    #[topic]
    pub id: u64,
    pub amount: i128,
}

/// Feed do Merkle (§4.6).
#[contractevent]
pub struct Response {
    #[topic]
    pub id: u64,
    pub responder: Address,
    pub response_hash: BytesN<32>,
}

#[contractevent]
pub struct Claimed {
    #[topic]
    pub id: u64,
    pub responder: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Closed {
    #[topic]
    pub id: u64,
    pub merkle_root: BytesN<32>,
    pub count: u32,
}

#[contractevent]
pub struct Refunded {
    #[topic]
    pub id: u64,
    pub amount: i128,
}

// ------------------------------------------------------------ helpers

fn load_survey(env: &Env, id: u64) -> Survey {
    match env.storage().persistent().get(&DataKey::Survey(id)) {
        Some(survey) => survey,
        None => panic_with_error!(env, Error::ERR_BAD_STATE),
    }
}

fn token_addr(env: &Env) -> Address {
    match env.storage().instance().get(&DataKey::Token) {
        Some(addr) => addr,
        None => panic_with_error!(env, Error::ERR_BAD_STATE),
    }
}

/// §4.2 — TTL mínimo de 30 dias; só estende. No-op se a entry não existe.
fn extend_persistent(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL, PERSISTENT_TTL);
    }
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(PERSISTENT_TTL, PERSISTENT_TTL);
}

/// §4.2 — TTL de `Response`/`Claimed`: `deadline − agora (+ folga)`, contido no
/// teto de temporary para não trapar.
fn response_ttl(env: &Env, deadline: u64) -> u32 {
    let seq = u64::from(env.ledger().sequence());
    let ttl = deadline
        .saturating_sub(seq)
        .saturating_add(u64::from(RESPONSE_GRACE));
    ttl.clamp(u64::from(MIN_TEMPORARY_TTL), u64::from(MAX_TEMPORARY_TTL)) as u32
}

fn extend_temporary(env: &Env, key: &DataKey, deadline: u64) {
    let ttl = response_ttl(env, deadline);
    env.storage().temporary().extend_ttl(key, ttl, ttl);
}

// ------------------------------------------------------------- contrato

/// `SolarveyEscrow` — escrow de recompensas de pesquisa (§4).
#[contract]
pub struct SolarveyEscrow;

#[contractimpl]
impl SolarveyEscrow {
    /// §4.3 — setup único. Guardado contra reinit.
    pub fn initialize(env: Env, admin: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        extend_instance(&env);
    }

    /// §4.3 — cria e persiste o survey; devolve o id.
    pub fn create_survey(
        env: Env,
        owner: Address,
        questions_hash: BytesN<32>,
        reward: i128,
        max_responses: u32,
        deadline: u64,
    ) -> u64 {
        if !env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }
        owner.require_auth();

        // §6: i128 + checked ops; `reward × max_responses` não pode estourar.
        if reward <= 0 || max_responses == 0 {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }
        if reward.checked_mul(i128::from(max_responses)).is_none() {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }

        let seq = u64::from(env.ledger().sequence());
        if deadline <= seq {
            panic_with_error!(&env, Error::ERR_DEADLINE);
        }
        // Ver cabeçalho: sem este teto o TTL temporário de `Response` estoura o
        // teto da rede e o invariante 2 quebra silenciosamente.
        if deadline > seq + MAX_SURVEY_LIFETIME {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let next_id = match id.checked_add(1) {
            Some(n) => n,
            None => panic_with_error!(&env, Error::ERR_BAD_STATE),
        };

        let survey = Survey {
            id,
            owner: owner.clone(),
            questions_hash: questions_hash.clone(),
            reward,
            max_responses,
            responded: 0,
            deadline,
            state: State::Open,
            merkle_root: BytesN::from_array(&env, &[0u8; 32]),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Survey(id), &survey);
        extend_persistent(&env, &DataKey::Survey(id));

        env.storage().instance().set(&DataKey::NextId, &next_id);
        extend_instance(&env);

        SurveyCreated {
            id,
            owner,
            questions_hash,
            reward,
            max_responses,
            deadline,
        }
        .publish(&env);

        id
    }

    /// §4.4 regra 1 — `state == Open`, saldo do criador ≥ `reward × max_responses`,
    /// e uma única vez por survey.
    pub fn fund(env: Env, owner: Address, id: u64) {
        let survey = load_survey(&env, id);
        if survey.owner != owner {
            panic_with_error!(&env, Error::ERR_NOT_AUTH);
        }
        owner.require_auth();

        if survey.state != State::Open {
            panic_with_error!(&env, Error::ERR_CLOSED);
        }
        if env.storage().persistent().has(&DataKey::Escrow(id)) {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }

        let total = match survey.reward.checked_mul(i128::from(survey.max_responses)) {
            Some(total) => total,
            None => panic_with_error!(&env, Error::ERR_BAD_STATE),
        };

        let token = TokenClient::new(&env, &token_addr(&env));
        if token.balance(&owner) < total {
            panic_with_error!(&env, Error::ERR_INSUFFICIENT_ESCROW);
        }
        token.transfer(&owner, env.current_contract_address(), &total);

        env.storage().persistent().set(&DataKey::Escrow(id), &total);
        extend_persistent(&env, &DataKey::Escrow(id));
        extend_persistent(&env, &DataKey::Survey(id));
        extend_instance(&env);

        Funded { id, amount: total }.publish(&env);
    }

    /// §4.4 regra 2 — `Open`, `sequence < deadline`, `responded < max_responses`
    /// e sem `Response(id, responder)` prévio. Regra 6: o deadline é a trava dura.
    pub fn submit(env: Env, responder: Address, id: u64, response_hash: BytesN<32>) {
        let mut survey = load_survey(&env, id);
        responder.require_auth();

        if survey.state != State::Open {
            panic_with_error!(&env, Error::ERR_CLOSED);
        }
        if u64::from(env.ledger().sequence()) >= survey.deadline {
            panic_with_error!(&env, Error::ERR_DEADLINE);
        }
        if survey.responded >= survey.max_responses {
            panic_with_error!(&env, Error::ERR_FULL);
        }

        let rkey = DataKey::Response(id, responder.clone());
        if env.storage().temporary().has(&rkey) {
            panic_with_error!(&env, Error::ERR_ALREADY_RESPONDED);
        }
        env.storage().temporary().set(&rkey, &response_hash);
        extend_temporary(&env, &rkey, survey.deadline);

        survey.responded += 1;
        env.storage()
            .persistent()
            .set(&DataKey::Survey(id), &survey);
        extend_persistent(&env, &DataKey::Survey(id));
        extend_persistent(&env, &DataKey::Escrow(id));
        extend_instance(&env);

        Response {
            id,
            responder,
            response_hash,
        }
        .publish(&env);
    }

    /// §4.4 regra 3 — `Response(id, responder)` existente, `Escrow(id) ≥ reward`
    /// e sem claim prévio (marca `claimed` em temporary). Regra 4: continua
    /// válido depois do `close`.
    pub fn claim(env: Env, responder: Address, id: u64) {
        let survey = load_survey(&env, id);
        responder.require_auth();

        let rkey = DataKey::Response(id, responder.clone());
        if !env.storage().temporary().has(&rkey) {
            panic_with_error!(&env, Error::ERR_NO_RESPONSE);
        }
        let ckey = DataKey::Claimed(id, responder.clone());
        if env.storage().temporary().has(&ckey) {
            panic_with_error!(&env, Error::ERR_ALREADY_CLAIMED);
        }

        let ekey = DataKey::Escrow(id);
        if !env.storage().persistent().has(&ekey) {
            panic_with_error!(&env, Error::ERR_NOT_FUNDED);
        }
        let escrow: i128 = env.storage().persistent().get(&ekey).unwrap_or(0);
        if escrow < survey.reward {
            panic_with_error!(&env, Error::ERR_INSUFFICIENT_ESCROW);
        }

        env.storage().temporary().set(&ckey, &());
        extend_temporary(&env, &ckey, survey.deadline);

        let remaining = escrow - survey.reward;
        env.storage().persistent().set(&ekey, &remaining);
        extend_persistent(&env, &ekey);
        extend_persistent(&env, &DataKey::Survey(id));
        extend_instance(&env);

        let token = TokenClient::new(&env, &token_addr(&env));
        token.transfer(&env.current_contract_address(), &responder, &survey.reward);

        Claimed {
            id,
            responder,
            amount: survey.reward,
        }
        .publish(&env);
    }

    /// §4.4 regra 4 — owner, `Open` e `count == responded`; grava `merkle_root`
    /// e transiciona `Open → Closed`. Não toca em claims.
    pub fn close(env: Env, owner: Address, id: u64, merkle_root: BytesN<32>, count: u32) {
        let mut survey = load_survey(&env, id);
        if survey.owner != owner {
            panic_with_error!(&env, Error::ERR_NOT_AUTH);
        }
        owner.require_auth();

        if survey.state != State::Open {
            panic_with_error!(&env, Error::ERR_CLOSED);
        }
        if count != survey.responded {
            panic_with_error!(&env, Error::ERR_COUNT_MISMATCH);
        }

        survey.merkle_root = merkle_root.clone();
        survey.state = State::Closed;
        env.storage()
            .persistent()
            .set(&DataKey::Survey(id), &survey);
        extend_persistent(&env, &DataKey::Survey(id));
        extend_persistent(&env, &DataKey::Escrow(id));
        extend_instance(&env);

        Closed {
            id,
            merkle_root,
            count,
        }
        .publish(&env);
    }

    /// §4.4 regra 5 — owner, e `Closed` ou `sequence > deadline`; devolve o
    /// residual de `Escrow(id)`.
    pub fn refund(env: Env, owner: Address, id: u64) {
        let survey = load_survey(&env, id);
        if survey.owner != owner {
            panic_with_error!(&env, Error::ERR_NOT_AUTH);
        }
        owner.require_auth();

        let past_deadline = u64::from(env.ledger().sequence()) > survey.deadline;
        if survey.state != State::Closed && !past_deadline {
            panic_with_error!(&env, Error::ERR_BAD_STATE);
        }

        let ekey = DataKey::Escrow(id);
        if !env.storage().persistent().has(&ekey) {
            panic_with_error!(&env, Error::ERR_NOT_FUNDED);
        }
        let amount: i128 = env.storage().persistent().get(&ekey).unwrap_or(0);
        if amount <= 0 {
            panic_with_error!(&env, Error::ERR_INSUFFICIENT_ESCROW);
        }

        // Zera, não remove: `fund` continua bloqueado (§4.4 regra 1).
        env.storage().persistent().set(&ekey, &0i128);
        extend_persistent(&env, &ekey);
        extend_persistent(&env, &DataKey::Survey(id));
        extend_instance(&env);

        let token = TokenClient::new(&env, &token_addr(&env));
        token.transfer(&env.current_contract_address(), &owner, &amount);

        Refunded { id, amount }.publish(&env);
    }

    // ------------------------------------------------- views §4.3 (read-only)

    pub fn get_survey(env: Env, id: u64) -> Survey {
        load_survey(&env, id)
    }

    pub fn has_responded(env: Env, id: u64, addr: Address) -> bool {
        env.storage().temporary().has(&DataKey::Response(id, addr))
    }

    pub fn get_escrow(env: Env, id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(id))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
