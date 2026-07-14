use anchor_lang::prelude::Space;
use calledit_escrow::{
    encoding::{
        hash_canonical_bytes, AttestationCommonV1, FeedEventAttestationV1, FeedEventKind,
        MarketDocumentV1, PositionInvalidationAttestationV1, QuoteAttestationV1, ScoreV1,
        SettlementAttestationV1, VoidAttestationV1, VoidReason,
    },
    math::{compute_pots, ratio_milli, settle_positions, MathError, SettlementInput},
    state::{
        Asset, Market, OracleSet, PositionLot, PositionSide, ProtocolConfig, SettlementOutcome,
        UserPosition, MARKET_ACCOUNT_SPACE, ORACLE_SET_ACCOUNT_SPACE, POSITION_LOT_ACCOUNT_SPACE,
        PROTOCOL_CONFIG_ACCOUNT_SPACE, USER_POSITION_ACCOUNT_SPACE,
    },
};
use proptest::prelude::*;
use solana_program::rent::Rent;

#[test]
fn account_layouts_are_frozen() {
    assert_eq!(ProtocolConfig::INIT_SPACE, 371);
    assert_eq!(OracleSet::INIT_SPACE, 128);
    assert_eq!(Market::INIT_SPACE, 425);
    assert_eq!(UserPosition::INIT_SPACE, 133);
    assert_eq!(PositionLot::INIT_SPACE, 150);
}

#[test]
fn residual_recipient_is_pinned_in_config_and_market_layouts() {
    let _config_residual = |config: &ProtocolConfig| config.residual_recipient;
    let _market_residual = |market: &Market| market.residual_recipient;
}

#[test]
fn account_rent_budget_uses_full_serialized_sizes() {
    let rent = Rent::default();
    let budgets = [
        ("protocol_config", PROTOCOL_CONFIG_ACCOUNT_SPACE),
        ("oracle_set", ORACLE_SET_ACCOUNT_SPACE),
        ("market", MARKET_ACCOUNT_SPACE),
        ("user_position", USER_POSITION_ACCOUNT_SPACE),
        ("position_lot", POSITION_LOT_ACCOUNT_SPACE),
    ];
    let total = budgets.iter().try_fold(0u64, |sum, (_, bytes)| {
        sum.checked_add(rent.minimum_balance(*bytes))
    });
    assert!(total.is_some());
    assert!(budgets
        .iter()
        .all(|(_, bytes)| rent.minimum_balance(*bytes) > 0));
}

#[test]
fn ratio_golden_vectors_match_the_reference_formula() {
    let vectors = [
        (500_000, 1_000),
        (610_000, 639),
        (800_000, 250),
        (999_500, 1),
        (999_990, 1),
        (10_000, 99_000),
        (333_333, 2_000),
        (666_667, 500),
    ];

    for (probability_ppm, expected) in vectors {
        assert_eq!(ratio_milli(probability_ppm), Ok(expected));
    }
    assert_eq!(ratio_milli(0), Err(MathError::InvalidProbability));
    assert_eq!(ratio_milli(1_000_000), Err(MathError::InvalidProbability));
}

#[test]
fn matching_and_partial_payout_golden_vectors_are_exact() {
    let pots = compute_pots(60_000_000, 20_000_000, 1_000).unwrap();
    assert_eq!(pots.matched_back, 20_000_000);
    assert_eq!(pots.matched_doubt, 20_000_000);

    let positions = [
        SettlementInput::active(1, PositionSide::Back, 60_000_000),
        SettlementInput::active(2, PositionSide::Doubt, 20_000_000),
    ];
    let result = settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000).unwrap();
    assert_eq!(result.credits[0].payout, 80_000_000);
    assert_eq!(result.credits[0].refund, 0);
    assert_eq!(result.credits[1].payout, 0);
    assert_eq!(result.credits[1].refund, 0);
    assert_eq!(result.dust, 0);
}

#[test]
fn skewed_ratio_allows_one_doubt_unit_to_cover_multiple_back_units() {
    // p=0.8 => ratio 250: 20 doubt units fully cover 80 back units.
    let pots = compute_pots(80, 20, 250).unwrap();
    assert_eq!(pots.matched_back, 80);
    assert_eq!(pots.matched_doubt, 20);
}

#[test]
fn pending_invalidated_and_voided_positions_refund_in_full() {
    let positions = [
        SettlementInput::active(1, PositionSide::Back, 40),
        SettlementInput::active(2, PositionSide::Doubt, 40),
        SettlementInput::pending(3, PositionSide::Back, 10),
        SettlementInput::refundable(4, PositionSide::Doubt, 11),
    ];
    let settled = settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000).unwrap();
    assert_eq!(settled.credits[2].refund, 10);
    assert_eq!(settled.credits[3].refund, 11);

    let voided = settle_positions(&positions, SettlementOutcome::Void, 1_000).unwrap();
    assert_eq!(voided.total_credited().unwrap(), 101);
    assert_eq!(voided.dust, 0);
}

#[test]
fn one_sided_market_returns_every_position_in_full() {
    let positions = [
        SettlementInput::active(1, PositionSide::Back, 10),
        SettlementInput::active(2, PositionSide::Back, 20),
    ];
    let result = settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000).unwrap();
    assert_eq!(result.total_credited().unwrap(), 30);
    assert_eq!(result.dust, 0);
}

#[test]
fn per_owner_aggregate_flooring_dust_is_explicit_and_conserved() {
    let positions = [
        SettlementInput::active(1, PositionSide::Back, 1),
        SettlementInput::active(2, PositionSide::Back, 1),
        SettlementInput::active(3, PositionSide::Back, 1),
        SettlementInput::active(4, PositionSide::Doubt, 2),
    ];
    let result = settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000).unwrap();
    assert_eq!(result.pots.matched_back, 2);
    assert_eq!(result.pots.matched_doubt, 2);
    assert_eq!(result.forfeited_pot, 2);
    assert_eq!(result.total_credited().unwrap(), 3);
    assert_eq!(result.dust, 2);
}

#[test]
fn payout_matches_the_shared_cross_language_golden_vector() {
    let positions = [
        SettlementInput::active(1, PositionSide::Back, 1_000),
        SettlementInput::active(2, PositionSide::Back, 500),
        SettlementInput::active(3, PositionSide::Doubt, 1_000),
        SettlementInput::pending(4, PositionSide::Back, 100),
    ];
    let result = settle_positions(&positions, SettlementOutcome::ClaimWon, 2_000).unwrap();
    assert_eq!(result.pots.matched_back, 500);
    assert_eq!(result.pots.matched_doubt, 1_000);
    assert_eq!(result.credits[0].payout, 1_666);
    assert_eq!(result.credits[1].payout, 833);
    assert_eq!(result.credits[2].refund, 0);
    assert_eq!(result.credits[3].refund, 100);
    assert_eq!(result.total_credited().unwrap(), 2_599);
    assert_eq!(result.dust, 1);
}

#[test]
fn canonical_encodings_match_the_shared_typescript_vectors_byte_for_byte() {
    let common = AttestationCommonV1 {
        cluster_genesis_hash: [1; 32],
        escrow_program_id: [2; 32],
        market_pda: [3; 32],
        market_document_hash: [4; 32],
        fixture_id: 91_001,
        oracle_set_epoch: 7,
        issued_at: 1_730_000_000,
        expires_at: 1_730_000_300,
        evidence_hash: [5; 32],
    };
    let market = MarketDocumentV1 {
        market_uuid: [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ],
        fixture_id: 91_001,
        claim_specification_hash: [10; 32],
        display_terms_hash: [11; 32],
        asset: Asset::Usdc,
        probability_ppm: 620_000,
        ratio_milli: 613,
        odds_message_hash: [9; 32],
        odds_timestamp: 1_730_000_000,
        position_cutoff: 1_730_003_600,
        resolution_deadline: 1_730_090_000,
        fee_bps: 0,
        oracle_set_epoch: 7,
        replay_flag: false,
    }
    .encode()
    .unwrap();
    let quote = QuoteAttestationV1 {
        common,
        probability_ppm: 620_000,
        ratio_milli: 613,
        odds_timestamp: 1_730_000_000,
    }
    .encode()
    .unwrap();
    let feed_event = FeedEventAttestationV1 {
        common,
        event_kind: FeedEventKind::PriceMoving,
        event_epoch: 9,
        deciding_sequence: 1_234,
        observed_at: 1_730_000_120,
    }
    .encode()
    .unwrap();
    let position_invalidation = PositionInvalidationAttestationV1 {
        common,
        position_lot_pda: [6; 32],
        lot_nonce: 4,
        observed_event_epoch: 8,
        invalidated_event_epoch: 9,
        deciding_sequence: 1_234,
    }
    .encode()
    .unwrap();
    let settlement = SettlementAttestationV1 {
        common,
        outcome: SettlementOutcome::ClaimWon,
        deciding_sequence: 2_000,
        terminal_phase: "FT",
        regulation_score: Some(ScoreV1 { home: 2, away: 1 }),
        full_match_score: Some(ScoreV1 { home: 2, away: 1 }),
        evidence_sequence_commitment: [7; 32],
        normalized_evidence_root: [8; 32],
    }
    .encode()
    .unwrap();
    let voided = VoidAttestationV1 {
        common,
        reason: VoidReason::CoverageLoss,
        deciding_sequence: 2_001,
    }
    .encode()
    .unwrap();

    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/escrow-sdk/vectors/canonical-v1.json"
    ))
    .unwrap();
    for (name, encoded) in [
        ("market", market),
        ("quote", quote),
        ("feed_event", feed_event),
        ("position_invalidation", position_invalidation),
        ("settlement", settlement),
        ("void", voided),
    ] {
        let expected = &vectors["vectors"][name];
        assert_eq!(
            to_hex(&encoded),
            expected["encoded_hex"].as_str().unwrap(),
            "{name} bytes"
        );
        assert_eq!(
            to_hex(&hash_canonical_bytes(&encoded)),
            expected["hash_hex"].as_str().unwrap(),
            "{name} hash"
        );
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use core::fmt::Write;
        write!(&mut output, "{byte:02x}").unwrap();
    }
    output
}

#[test]
fn checked_math_rejects_invalid_ratio_and_overflow() {
    assert_eq!(compute_pots(1, 1, 0), Err(MathError::InvalidRatio));

    let positions = [
        SettlementInput::active(1, PositionSide::Back, u64::MAX),
        SettlementInput::active(2, PositionSide::Back, 1),
    ];
    assert_eq!(
        settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000),
        Err(MathError::Overflow)
    );
}

#[test]
fn duplicate_owner_aggregates_and_opposite_sides_are_rejected() {
    let duplicate = [
        SettlementInput::active(7, PositionSide::Back, 10),
        SettlementInput::active(7, PositionSide::Back, 20),
    ];
    assert_eq!(
        settle_positions(&duplicate, SettlementOutcome::ClaimWon, 1_000),
        Err(MathError::DuplicateOwner)
    );

    let opposite = [
        SettlementInput::active(7, PositionSide::Back, 10),
        SettlementInput::active(7, PositionSide::Doubt, 20),
    ];
    assert_eq!(
        settle_positions(&opposite, SettlementOutcome::ClaimWon, 1_000),
        Err(MathError::OppositeSide)
    );
}

#[test]
fn aggregate_user_position_settles_active_once_and_refunds_other_buckets() {
    let positions = [
        SettlementInput::new(1, PositionSide::Back, 40, 10, 5),
        SettlementInput::active(2, PositionSide::Doubt, 40),
    ];
    let result = settle_positions(&positions, SettlementOutcome::ClaimWon, 1_000).unwrap();
    assert_eq!(result.credits[0].payout, 80);
    assert_eq!(result.credits[0].refund, 15);
    assert_eq!(result.credits[1].payout, 0);
    assert_eq!(result.credits[1].refund, 0);
    assert_eq!(result.total_credited().unwrap(), 95);
    assert_eq!(result.dust, 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    #[test]
    fn randomized_settlement_conserves_every_asset_unit(
        probability_ppm in 1u32..1_000_000,
        raw in prop::collection::vec((any::<bool>(), 1u64..100_000_000, 0u8..5), 1..10),
        outcome_tag in 0u8..3,
    ) {
        let ratio = ratio_milli(probability_ppm).unwrap();
        let positions: Vec<_> = raw
            .into_iter()
            .enumerate()
            .map(|(index, (back, amount, state_tag))| {
                let side = if back { PositionSide::Back } else { PositionSide::Doubt };
                match state_tag {
                    0..=2 => SettlementInput::active(index as u64, side, amount),
                    3 => SettlementInput::pending(index as u64, side, amount),
                    _ => SettlementInput::refundable(index as u64, side, amount),
                }
            })
            .collect();
        let outcome = match outcome_tag {
            0 => SettlementOutcome::ClaimWon,
            1 => SettlementOutcome::ClaimLost,
            _ => SettlementOutcome::Void,
        };

        let escrowed = positions.iter().try_fold(0u64, |sum, p| {
            sum.checked_add(p.active_amount)?
                .checked_add(p.pending_amount)?
                .checked_add(p.refundable_amount)
        }).unwrap();
        let result = settle_positions(&positions, outcome, ratio).unwrap();
        let credited = result.total_credited().unwrap();

        prop_assert!(credited <= escrowed);
        prop_assert_eq!(escrowed - credited, result.dust);
        prop_assert!(result.dust <= positions.len() as u64);
    }
}
