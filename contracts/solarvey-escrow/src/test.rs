#![cfg(test)]

extern crate std;

// Testes do contrato — cobrem §4.4 (invariantes 1..6), §4.7 (todos os 11
// códigos) e §4.2 (TTL), mais as arestas exigidas no plano:
//   deadline exato · max_responses exato · refund duplicado.

use crate::{
    DataKey, Error, SolarveyEscrow, SolarveyEscrowClient, State, DAY_IN_LEDGERS,
    MAX_SURVEY_LIFETIME, PERSISTENT_TTL, RESPONSE_GRACE, STROOPS_PER_XLM,
};
use soroban_sdk::testutils::{
    storage::{Persistent as _, Temporary as _},
    Address as _, Events as _, Ledger as _,
};
use soroban_sdk::{
    token::{StellarAssetClient, TokenClient},
    xdr::{ContractEventBody, ScSymbol, ScVal},
    Address, BytesN, Env,
};

/// Ledger inicial de todos os testes.
const SEQ0: u32 = 1_000;
/// Recompensa por resposta: 1 XLM.
const REWARD: i128 = STROOPS_PER_XLM;
/// Capacidade padrão de um survey.
const MAX_RESP: u32 = 3;
/// `deadline` padrão = SEQ0 + 100.
const DEADLINE: u64 = SEQ0 as u64 + 100;

// --------------------------------------------------------------- infra

struct Fx {
    env: Env,
    id: Address,
    admin: Address,
    owner: Address,
    other: Address,
    resp: Address,
    token: Address,
}

impl Fx {
    fn client(&self) -> SolarveyEscrowClient<'_> {
        SolarveyEscrowClient::new(&self.env, &self.id)
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    fn seq(&self) -> u32 {
        self.env.ledger().sequence()
    }

    fn set_seq(&self, seq: u32) {
        self.env.ledger().set_sequence_number(seq);
    }

    /// Cria um survey padrão (`deadline` = SEQ0 + 100) e devolve o id.
    fn create(&self) -> u64 {
        self.client().create_survey(
            &self.owner,
            &hash(&self.env, 7),
            &REWARD,
            &MAX_RESP,
            &DEADLINE,
        )
    }

    fn persistent_ttl(&self, key: &DataKey) -> u32 {
        let env = self.env.clone();
        env.as_contract(&self.id, || env.storage().persistent().get_ttl(key))
    }

    fn temporary_ttl(&self, key: &DataKey) -> u32 {
        let env = self.env.clone();
        env.as_contract(&self.id, || env.storage().temporary().get_ttl(key))
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(SEQ0);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let other = Address::generate(&env);
    let resp = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let id = env.register(SolarveyEscrow, ());
    SolarveyEscrowClient::new(&env, &id).initialize(&admin, &token);

    // Fundo do criador: 1000 XLM.
    StellarAssetClient::new(&env, &token).mint(&owner, &(1_000 * STROOPS_PER_XLM));

    Fx {
        env,
        id,
        admin,
        owner,
        other,
        resp,
        token,
    }
}

/// Achata o resultado de um `try_*` e compara com o código de §4.7.
fn expect_err<T, E>(
    r: Result<Result<T, E>, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
    expected: Error,
) {
    let outer = match r {
        Err(outer) => outer,
        Ok(_) => panic!("esperava {expected:?}, mas a chamada passou"),
    };
    let sdk_err = match outer {
        Ok(e) => e,
        Err(_) => panic!("esperava o erro de contrato {expected:?}, mas foi erro de host"),
    };
    assert_eq!(Error::try_from(sdk_err), Ok(expected));
}

fn sym(name: &str) -> ScVal {
    ScVal::Symbol(ScSymbol::try_from(name).unwrap())
}

/// Topics e data do último evento publicado pela última invocação.
fn last_event(fx: &Fx) -> (std::vec::Vec<ScVal>, ScVal) {
    let events = fx.env.events().all();
    let event = events
        .events()
        .last()
        .expect("a invocação não publicou evento");
    match event.clone().body {
        ContractEventBody::V0(v) => (v.topics.to_vec(), v.data),
    }
}

// ------------------------------------------------------- initialize

#[test]
fn test_initialize_sets_admin_and_token() {
    let fx = setup();
    let admin: Option<Address> = fx
        .env
        .as_contract(&fx.id, || fx.env.storage().instance().get(&DataKey::Admin));
    let token: Option<Address> = fx
        .env
        .as_contract(&fx.id, || fx.env.storage().instance().get(&DataKey::Token));
    let next_id: Option<u64> = fx
        .env
        .as_contract(&fx.id, || fx.env.storage().instance().get(&DataKey::NextId));

    assert_eq!(admin, Some(fx.admin.clone()));
    assert_eq!(token, Some(fx.token.clone()));
    assert_eq!(next_id, Some(1));
}

#[test]
fn test_initialize_twice_is_blocked() {
    let fx = setup();
    expect_err(
        fx.client().try_initialize(&fx.admin, &fx.token),
        Error::ERR_BAD_STATE,
    );
}

#[test]
fn test_initialize_requires_admin_auth() {
    // Sem `mock_all_auths` — `admin.require_auth()` deve falhar.
    let env = Env::default();
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let id = env.register(SolarveyEscrow, ());
    let client = SolarveyEscrowClient::new(&env, &id);
    assert!(client.try_initialize(&admin, &token).is_err());
}

// ---------------------------------------------------- create_survey

#[test]
fn test_create_survey_success_and_ids_increment() {
    let fx = setup();
    let c = fx.client();

    let id1 = c.create_survey(&fx.owner, &hash(&fx.env, 1), &REWARD, &MAX_RESP, &DEADLINE);

    // §4.6 — topicos exatos de `solarvey:survey_created` (lido imediatamente,
    // pois `env.events().all()` cobre só a última invocação).
    let (topics, data) = last_event(&fx);
    assert_eq!(topics, [sym("survey_created"), ScVal::U64(1)]);
    assert!(matches!(data, ScVal::Map(_)), "data deve ser um map");

    let id2 = c.create_survey(&fx.owner, &hash(&fx.env, 2), &REWARD, &MAX_RESP, &DEADLINE);
    assert_eq!((id1, id2), (1, 2));

    let s = c.get_survey(&1);
    assert_eq!(s.id, 1);
    assert_eq!(s.owner, fx.owner);
    assert_eq!(s.questions_hash, hash(&fx.env, 1));
    assert_eq!(s.reward, REWARD);
    assert_eq!(s.max_responses, MAX_RESP);
    assert_eq!(s.responded, 0);
    assert_eq!(s.deadline, DEADLINE);
    assert_eq!(s.state, State::Open);
    assert_eq!(s.merkle_root, hash(&fx.env, 0));
}

#[test]
fn test_create_survey_requires_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(SEQ0);
    let owner = Address::generate(&env);
    let id = env.register(SolarveyEscrow, ());
    let c = SolarveyEscrowClient::new(&env, &id);
    expect_err(
        c.try_create_survey(&owner, &hash(&env, 1), &REWARD, &MAX_RESP, &DEADLINE),
        Error::ERR_BAD_STATE,
    );
}

#[test]
fn test_create_survey_zero_reward() {
    let fx = setup();
    expect_err(
        fx.client()
            .try_create_survey(&fx.owner, &hash(&fx.env, 1), &0, &MAX_RESP, &DEADLINE),
        Error::ERR_BAD_STATE,
    );
}

#[test]
fn test_create_survey_zero_max_responses() {
    let fx = setup();
    expect_err(
        fx.client()
            .try_create_survey(&fx.owner, &hash(&fx.env, 1), &REWARD, &0, &DEADLINE),
        Error::ERR_BAD_STATE,
    );
}

#[test]
fn test_create_survey_reward_times_max_overflows_i128() {
    let fx = setup();
    expect_err(
        fx.client()
            .try_create_survey(&fx.owner, &hash(&fx.env, 1), &i128::MAX, &10, &DEADLINE),
        Error::ERR_BAD_STATE,
    );
}

#[test]
fn test_create_survey_deadline_in_the_past() {
    let fx = setup();
    fx.set_seq(SEQ0 + 50);
    // deadline == sequence corrente ⇒ regra 6 exige `sequence < deadline`.
    expect_err(
        fx.client().try_create_survey(
            &fx.owner,
            &hash(&fx.env, 1),
            &REWARD,
            &MAX_RESP,
            &u64::from(SEQ0 + 50),
        ),
        Error::ERR_DEADLINE,
    );
}

#[test]
fn test_create_survey_deadline_beyond_max_survey_lifetime() {
    let fx = setup();
    expect_err(
        fx.client().try_create_survey(
            &fx.owner,
            &hash(&fx.env, 1),
            &REWARD,
            &MAX_RESP,
            &(u64::from(SEQ0) + MAX_SURVEY_LIFETIME + 1),
        ),
        Error::ERR_BAD_STATE,
    );
}

// ------------------------------------------------------------ fund (§4.4 r1)

#[test]
fn test_fund_success_moves_total_into_escrow() {
    let fx = setup();
    let id = fx.create();
    let total = REWARD * i128::from(MAX_RESP);

    let before = fx.token().balance(&fx.owner);
    fx.client().fund(&fx.owner, &id);

    // §4.6 — lido logo após a invocação que publica.
    let (topics, _data) = last_event(&fx);
    assert_eq!(topics, [sym("funded"), ScVal::U64(id)]);

    assert_eq!(fx.client().get_escrow(&id), total);
    assert_eq!(fx.token().balance(&fx.owner), before - total);
    assert_eq!(fx.token().balance(&fx.id), total);
}

#[test]
fn test_fund_by_non_owner_is_rejected() {
    let fx = setup();
    let id = fx.create();
    expect_err(fx.client().try_fund(&fx.other, &id), Error::ERR_NOT_AUTH);
}

#[test]
fn test_fund_twice_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    expect_err(fx.client().try_fund(&fx.owner, &id), Error::ERR_BAD_STATE);
}

#[test]
fn test_fund_after_close_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 9), &0);
    expect_err(fx.client().try_fund(&fx.owner, &id), Error::ERR_CLOSED);
}

#[test]
fn test_fund_with_insufficient_creator_balance() {
    let fx = setup();
    // 500 XLM × 3 = 1500 XLM > saldo do criador (1000 XLM).
    let id = fx.client().create_survey(
        &fx.owner,
        &hash(&fx.env, 1),
        &(500 * STROOPS_PER_XLM),
        &3,
        &DEADLINE,
    );
    expect_err(
        fx.client().try_fund(&fx.owner, &id),
        Error::ERR_INSUFFICIENT_ESCROW,
    );
}

#[test]
fn test_fund_after_refund_is_still_blocked() {
    // Invariante 1: "uma única vez por survey" — o refund zera o escrow mas não
    // remove a entrada, então `fund` continua recusado.
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.set_seq(SEQ0 + 200);
    fx.client().refund(&fx.owner, &id);
    expect_err(fx.client().try_fund(&fx.owner, &id), Error::ERR_BAD_STATE);
}

// ---------------------------------------------------------- submit (§4.4 r2/r6)

#[test]
fn test_submit_success_records_response() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);

    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 42));

    let (topics, _data) = last_event(&fx);
    assert_eq!(topics, [sym("response"), ScVal::U64(id)]);

    assert_eq!(fx.client().get_survey(&id).responded, 1);
    assert!(fx.client().has_responded(&id, &fx.resp));
    assert!(!fx.client().has_responded(&id, &fx.other));
}

#[test]
fn test_submit_at_exact_deadline_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.set_seq(SEQ0 + 100); // == DEADLINE
    expect_err(
        fx.client().try_submit(&fx.resp, &id, &hash(&fx.env, 1)),
        Error::ERR_DEADLINE,
    );
}

#[test]
fn test_submit_after_deadline_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.set_seq(SEQ0 + 101);
    expect_err(
        fx.client().try_submit(&fx.resp, &id, &hash(&fx.env, 1)),
        Error::ERR_DEADLINE,
    );
}

#[test]
fn test_submit_when_closed_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 9), &0);
    expect_err(
        fx.client().try_submit(&fx.resp, &id, &hash(&fx.env, 1)),
        Error::ERR_CLOSED,
    );
}

#[test]
fn test_submit_at_exact_max_responses_is_rejected() {
    let fx = setup();
    let c = fx.client();
    let id = c.create_survey(&fx.owner, &hash(&fx.env, 7), &REWARD, &1, &DEADLINE);
    c.fund(&fx.owner, &id);

    // 1ª resposta preenche `max_responses == 1`…
    c.submit(&fx.resp, &id, &hash(&fx.env, 1));
    // …e a 2ª é recusada com ERR_FULL.
    expect_err(
        c.try_submit(&fx.other, &id, &hash(&fx.env, 2)),
        Error::ERR_FULL,
    );
    assert_eq!(c.get_survey(&id).responded, 1);
}

#[test]
fn test_submit_twice_from_same_responder() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    expect_err(
        fx.client().try_submit(&fx.resp, &id, &hash(&fx.env, 2)),
        Error::ERR_ALREADY_RESPONDED,
    );
    assert_eq!(fx.client().get_survey(&id).responded, 1);
}

// ------------------------------------------------------- close (§4.4 r4)

#[test]
fn test_close_success_sets_state_and_root() {
    let fx = setup();
    let id = fx.create();
    let root = hash(&fx.env, 200);

    fx.client().close(&fx.owner, &id, &root, &0);

    let (topics, _data) = last_event(&fx);
    assert_eq!(topics, [sym("closed"), ScVal::U64(id)]);

    let s = fx.client().get_survey(&id);
    assert_eq!(s.state, State::Closed);
    assert_eq!(s.merkle_root, root);
}

#[test]
fn test_close_by_non_owner_is_rejected() {
    let fx = setup();
    let id = fx.create();
    expect_err(
        fx.client().try_close(&fx.other, &id, &hash(&fx.env, 1), &0),
        Error::ERR_NOT_AUTH,
    );
}

#[test]
fn test_close_with_wrong_count_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    // count != responded (0 != 1)
    expect_err(
        fx.client().try_close(&fx.owner, &id, &hash(&fx.env, 1), &0),
        Error::ERR_COUNT_MISMATCH,
    );
    assert_eq!(fx.client().get_survey(&id).state, State::Open);
}

#[test]
fn test_close_twice_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 1), &0);
    expect_err(
        fx.client().try_close(&fx.owner, &id, &hash(&fx.env, 2), &0),
        Error::ERR_CLOSED,
    );
}

// --------------------------------------------------------- claim (§4.4 r3/r4)

#[test]
fn test_claim_success_pays_reward_and_reduces_escrow() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));

    let total = REWARD * i128::from(MAX_RESP);
    assert_eq!(fx.token().balance(&fx.resp), 0);

    fx.client().claim(&fx.resp, &id);

    let (topics, _data) = last_event(&fx);
    assert_eq!(topics, [sym("claimed"), ScVal::U64(id)]);

    assert_eq!(fx.token().balance(&fx.resp), REWARD);
    assert_eq!(fx.client().get_escrow(&id), total - REWARD);
}

#[test]
fn test_claim_without_response_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    expect_err(fx.client().try_claim(&fx.resp, &id), Error::ERR_NO_RESPONSE);
}

#[test]
fn test_claim_twice_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    fx.client().claim(&fx.resp, &id);
    expect_err(
        fx.client().try_claim(&fx.resp, &id),
        Error::ERR_ALREADY_CLAIMED,
    );
}

#[test]
fn test_claim_on_unfunded_survey_is_rejected() {
    let fx = setup();
    let id = fx.create(); // sem fund()
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    expect_err(fx.client().try_claim(&fx.resp, &id), Error::ERR_NOT_FUNDED);
}

#[test]
fn test_claim_after_refund_is_rejected_for_insufficient_escrow() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 2), &1);
    fx.client().refund(&fx.owner, &id); // zera o escrow, mas a entrada fica
    expect_err(
        fx.client().try_claim(&fx.resp, &id),
        Error::ERR_INSUFFICIENT_ESCROW,
    );
}

#[test]
fn test_claim_still_valid_after_close() {
    // Invariante 4: o close não bloqueia claims.
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 2), &1);

    fx.client().claim(&fx.resp, &id);
    assert_eq!(fx.token().balance(&fx.resp), REWARD);
}

#[test]
fn test_claim_still_valid_after_deadline() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    fx.set_seq(SEQ0 + 500); // bem depois do deadline
    fx.client().claim(&fx.resp, &id);
    assert_eq!(fx.token().balance(&fx.resp), REWARD);
}

// -------------------------------------------------------- refund (§4.4 r5)

#[test]
fn test_refund_after_deadline_returns_residual() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    let total = REWARD * i128::from(MAX_RESP);

    fx.set_seq(SEQ0 + 101); // > DEADLINE
    let before = fx.token().balance(&fx.owner);
    fx.client().refund(&fx.owner, &id);

    let (topics, _data) = last_event(&fx);
    assert_eq!(topics, [sym("refunded"), ScVal::U64(id)]);

    assert_eq!(fx.token().balance(&fx.owner), before + total);
    assert_eq!(fx.client().get_escrow(&id), 0);
}

#[test]
fn test_refund_after_close_before_deadline() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().close(&fx.owner, &id, &hash(&fx.env, 2), &0);
    fx.client().refund(&fx.owner, &id);
    assert_eq!(fx.client().get_escrow(&id), 0);
}

#[test]
fn test_refund_by_non_owner_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.set_seq(SEQ0 + 101);
    expect_err(fx.client().try_refund(&fx.other, &id), Error::ERR_NOT_AUTH);
}

#[test]
fn test_refund_before_deadline_while_open_is_rejected() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    expect_err(fx.client().try_refund(&fx.owner, &id), Error::ERR_BAD_STATE);
}

#[test]
fn test_refund_on_unfunded_survey_is_rejected() {
    let fx = setup();
    let id = fx.create(); // nunca financiado
    fx.set_seq(SEQ0 + 101);
    expect_err(
        fx.client().try_refund(&fx.owner, &id),
        Error::ERR_NOT_FUNDED,
    );
}

#[test]
fn test_refund_twice_is_rejected() {
    // Aresta pedida no plano: refund duplicado.
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.set_seq(SEQ0 + 101);
    fx.client().refund(&fx.owner, &id);
    expect_err(
        fx.client().try_refund(&fx.owner, &id),
        Error::ERR_INSUFFICIENT_ESCROW,
    );
}

// ------------------------------------------------- views (§4.3) e invariantes

#[test]
fn test_views_reflect_state() {
    let fx = setup();
    let id = fx.create();

    assert_eq!(fx.client().get_escrow(&id), 0);
    assert!(!fx.client().has_responded(&id, &fx.resp));

    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 5));

    assert_eq!(fx.client().get_escrow(&id), REWARD * i128::from(MAX_RESP));
    assert!(fx.client().has_responded(&id, &fx.resp));
    assert_eq!(fx.client().get_survey(&id).responded, 1);
}

#[test]
fn test_get_survey_of_unknown_id_is_rejected() {
    let fx = setup();
    expect_err(fx.client().try_get_survey(&42), Error::ERR_BAD_STATE);
}

#[test]
fn test_escrow_never_exceeds_pool_after_full_cycle() {
    // Conservação do pool: total de saídas ≤ reward × max_responses.
    let fx = setup();
    let c = fx.client();
    let id = c.create_survey(&fx.owner, &hash(&fx.env, 7), &REWARD, &2, &DEADLINE);
    c.fund(&fx.owner, &id);

    let pool = REWARD * 2;
    assert_eq!(fx.token().balance(&fx.id), pool);

    c.submit(&fx.resp, &id, &hash(&fx.env, 1));
    c.submit(&fx.other, &id, &hash(&fx.env, 2));
    c.claim(&fx.resp, &id);
    c.claim(&fx.other, &id);

    assert_eq!(fx.client().get_escrow(&id), 0);
    assert_eq!(
        fx.token().balance(&fx.resp) + fx.token().balance(&fx.other),
        pool
    );
}

// ------------------------------------------------------------- TTL (§4.2)

#[test]
fn test_survey_and_escrow_ttl_are_30_days() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);

    assert_eq!(fx.persistent_ttl(&DataKey::Survey(id)), PERSISTENT_TTL);
    assert_eq!(fx.persistent_ttl(&DataKey::Escrow(id)), PERSISTENT_TTL);
}

#[test]
fn test_response_ttl_lives_until_deadline_plus_grace() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));

    let expected = (DEADLINE - u64::from(fx.seq())) as u32 + RESPONSE_GRACE;
    assert_eq!(
        fx.temporary_ttl(&DataKey::Response(id, fx.resp.clone())),
        expected
    );
}

#[test]
fn test_claimed_ttl_matches_response_ttl() {
    let fx = setup();
    let id = fx.create();
    fx.client().fund(&fx.owner, &id);
    fx.client().submit(&fx.resp, &id, &hash(&fx.env, 1));
    fx.client().claim(&fx.resp, &id);

    let expected = (DEADLINE - u64::from(fx.seq())) as u32 + RESPONSE_GRACE;
    assert_eq!(
        fx.temporary_ttl(&DataKey::Claimed(id, fx.resp.clone())),
        expected
    );
}

#[test]
fn test_persistent_ttl_never_shortens() {
    let fx = setup();
    let id = fx.create();
    // Uma segunda escrita no mesmo survey mantém o piso de 30 dias.
    fx.set_seq(SEQ0 + 10);
    fx.client().fund(&fx.owner, &id);
    assert_eq!(fx.persistent_ttl(&DataKey::Survey(id)), PERSISTENT_TTL);
}

#[test]
fn test_day_in_ledgers_constant() {
    // ~5 s por ledger ⇒ 17280 ledgers/dia (§4.2).
    assert_eq!(DAY_IN_LEDGERS, 17_280);
}
