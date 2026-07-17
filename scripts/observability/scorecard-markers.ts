export type ScorecardCheckDefinition = {
  readonly id: string;
  readonly mandatory: boolean;
};

export type ScorecardMarkerDefinition = {
  readonly id: string;
  readonly checks: readonly ScorecardCheckDefinition[];
};

export const HARD_GATES = [
  'no_duplicate_partial_or_insolvent_money_result',
  'no_identity_takeover_or_unverified_authority',
  'no_public_private_data_exposure',
  'no_accepted_ambiguous_txline_period',
  'no_lost_accepted_telegram_update_or_durable_job',
  'no_blind_duplicate_resend_after_uncertain_delivery',
  'no_serious_or_critical_accessibility_violation',
  'fresh_and_upgrade_migrations_pass',
  'restore_rollback_and_invariants_pass',
  'deployed_source_matches_reviewed_commit',
  'required_readiness_passes',
  'evidence_is_present_fresh_redacted_and_hashed',
  'every_scored_marker_is_at_least_nine',
] as const;

export const RELEASE_MARKERS = [
  marker('feature_completeness', [1, 2, 3, 5, 6, 8, 9, 10], [
    'public_add_to_group_entry_works', 'idempotent_group_ready_flow_works',
    'explicit_passive_and_friend_consent_work', 'two_choice_offer_and_amount_chooser_work',
    'starter_and_funded_positions_are_atomic', 'signed_wallet_funding_and_confirmation_work',
    'me_table_account_and_board_work', 'settlement_proof_and_receipt_close',
    'recovery_works_for_every_fixed_failure_state', 'no_dead_placeholder_demo_rep_or_raw_link_surface',
  ]),
  marker('entry_and_installation_ux', [1, 3, 4, 5, 10], [
    'every_cta_uses_current_versioned_telegram_url', 'cold_admin_identifies_next_action',
    'cold_admin_completes_installation_in_three_actions', 'group_ready_p95_is_at_most_five_seconds',
    'duplicate_delivery_produces_one_ready_message', 'minimal_requested_rights_are_clear',
    'missing_rights_and_reinstall_have_one_recovery_action', 'mobile_and_desktop_links_work',
    'test_sol_no_value_status_is_understood', 'no_setup_wizard_checklist_demo_or_command_wall',
  ]),
  marker('claim_and_consent_ux', [2, 3, 4, 9, 10], [
    'supported_explicit_claims_reach_correct_offer', 'passive_claims_require_speaker_confirmation',
    'friend_claims_require_quoted_speaker_confirmation', 'wrong_users_cannot_confirm',
    'expired_edited_deleted_and_superseded_candidates_fail_safely', 'offer_p95_is_at_most_five_seconds',
    'call_publicness_is_understood', 'every_refusal_has_one_next_action', 'raw_chat_is_never_public',
    'model_failure_cannot_mutate_market_or_consent',
  ]),
  marker('offer_and_first_position_ux', [2, 3, 5, 6, 7], [
    'two_outcome_buttons_are_understood', 'exact_amount_is_visible_before_tap',
    'eligible_first_time_user_completes_in_one_tap', 'default_position_p95_is_at_most_three_seconds',
    'one_tap_creates_one_grant_debit_and_position', 'duplicate_deliveries_create_no_duplicate_effect',
    'concurrent_taps_cannot_consume_two_starter_grants', 'refusals_identify_balance_change',
    'success_persists_after_chat_interruption', 'amount_chooser_is_requester_scoped',
  ]),
  marker('account_wallet_funding_and_withdrawal_ux', [1, 2, 3, 7, 8, 9], [
    'telegram_identity_is_validated_server_side', 'canonical_wallet_signature_verification_works',
    'raw_pasted_address_cannot_link', 'pending_intent_preserves_position_fields',
    'reload_and_reopen_restore_safe_state_without_local_secrets', 'funding_and_confirmation_are_distinct_and_clear',
    'wrong_wallet_network_or_signature_makes_no_mutation', 'relink_blockers_preserve_identity_and_money',
    'withdrawal_is_idempotent_and_recoverable', 'installed_wallet_cold_path_p95_is_at_most_ninety_seconds',
  ]),
  marker('board_receipt_settlement_and_proof_trust', [2, 3, 4, 5, 6, 7], [
    'board_shows_active_and_recent_sol_calls', 'receipt_terms_come_from_deterministic_specs',
    'pots_and_matched_amount_reconcile_exactly', 'refund_and_payout_reconcile_exactly',
    'stable_alias_is_the_only_participant_identity', 'proof_unavailability_is_honest',
    'verified_badge_requires_byte_verification', 'live_settlement_and_proof_updates_need_no_reload',
    'private_and_unknown_resources_are_non_leaky', 'board_receipt_group_navigation_is_complete',
  ]),
  marker('accessibility_and_language', [1, 2, 5, 8, 10], [
    'zero_serious_or_critical_axe_finding', 'keyboard_completes_every_critical_workflow',
    'focus_is_visible_and_correctly_ordered', 'one_h1_and_valid_headings_exist_on_every_page',
    'reflow_has_no_clipping_or_overlap', 'async_states_are_announced', 'reduced_motion_is_respected',
    'meaning_never_depends_on_color_emoji_animation_or_toast', 'b1_comprehension_assertions_pass',
    'every_error_follows_the_three_part_recovery_contract',
  ]),
  marker('recovery_and_consistency', [1, 2, 3, 4, 8, 9], [
    'duplicate_update_converges_to_one_result', 'engine_restart_after_acceptance_loses_no_update',
    'concierge_failure_propagates_for_retry', 'telegram_send_uncertainty_does_not_duplicate_message',
    'interrupted_wallet_flow_resumes', 'closed_or_stale_market_preserves_money',
    'unavailable_proof_preserves_settlement_and_states_limitation', 'deposit_and_withdrawal_interruption_converges',
    'reconciliation_has_zero_unexplained_gaps', 'cross_surface_copy_and_state_are_consistent',
  ]),
  marker('security_identity_and_privacy', [1, 3, 4, 5, 6, 7, 8, 9], [
    'route_scopes_pass_positive_and_negative_probes', 'pairwise_token_uniqueness_is_deployably_enforced',
    'sentinel_secrets_never_appear_in_logs_or_evidence', 'telegram_and_wallet_identity_cannot_be_swapped',
    'session_csrf_origin_host_and_fetch_metadata_checks_pass', 'private_tables_and_rpcs_are_unreachable',
    'public_views_contain_no_forbidden_field_or_sentinel', 'realtime_leaks_no_private_group_event',
    'model_and_external_text_cannot_grant_authority', 'secret_scan_and_lock_integrity_pass',
  ]),
  marker('ledger_and_solvency', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [
    'starter_path_is_atomic', 'funded_path_is_atomic', 'every_refusal_writes_nothing',
    'cap_and_budget_remain_exact_under_races', 'deposit_attribution_is_exact_and_idempotent',
    'withdrawal_reserve_submission_and_confirmation_are_exact', 'settlement_payout_and_refund_are_exact',
    'relink_cannot_transfer_or_strand_liability', 'complete_treasury_coverage_is_nonnegative',
    'fault_matrix_has_no_duplicate_or_orphan_money_effect',
  ]),
  marker('feed_jobs_and_delivery_durability', [1, 2, 3, 5, 6, 7], [
    'ambiguous_periods_are_rejected', 'ingress_persists_before_acknowledgement',
    'lease_exclusion_and_recovery_work', 'permanent_failures_dead_letter_without_blocking',
    'ownership_uncertainty_reconciles_without_blind_resend', 'settlement_jobs_survive_restart',
    'proof_jobs_survive_restart', 'poison_market_does_not_block_sweep',
    'backlog_and_oldest_age_queries_are_exact', 'retention_removes_only_eligible_terminal_data',
  ]),
  marker('ci_schema_and_dependency_quality', [2, 4, 5, 6, 7, 9], [
    'frozen_install_succeeds', 'every_workspace_builds_including_concierge', 'every_workspace_typechecks',
    'every_nonempty_test_suite_runs_and_zero_test_escape_fails', 'fresh_migration_path_passes',
    'upgrade_migration_path_passes', 'sql_concurrency_rls_and_privilege_suite_passes',
    'browser_and_accessibility_suite_pass_twice', 'no_reachable_unwaived_critical_high_or_moderate_advisory',
    'workflow_lock_secret_and_evidence_policy_checks_pass',
  ]),
  marker('observability_and_readiness', [2, 7, 9], [
    'liveness_remains_process_only', 'enabled_dependency_failures_make_readiness_fail',
    'disabled_capabilities_remain_explicitly_ready', 'every_queue_heartbeat_and_backlog_is_represented',
    'pii_safe_funnel_events_emit_exactly_once', 'local_otlp_collector_receives_bounded_signals',
    'every_alert_fires_under_synthetic_breach', 'every_alert_resolves_after_recovery',
    'reconciliation_dry_run_is_deterministic_and_write_free', 'unsafe_apply_is_rejected',
  ]),
  marker('deployment_backup_and_operations', [1, 2, 6, 7, 8, 9, 10], [
    'staging_and_production_resource_ids_differ', 'promotion_manifest_matches_commit_lock_migrations_and_builds',
    'engine_private_networking_and_scoped_auth_pass', 'web_source_and_build_are_current',
    'webhook_is_correct_with_zero_unexpected_backlog', 'disabled_first_capability_order_is_followed',
    'canary_has_no_hard_alert_or_unexpected_dead_letter', 'isolated_pitr_restore_reproduces_invariants',
    'rpo_and_rto_targets_are_met', 'forward_only_rollback_and_roll_forward_reconcile',
  ]),
] satisfies readonly ScorecardMarkerDefinition[];

function marker(
  id: string,
  mandatoryIndexes: readonly number[],
  checkIds: readonly string[],
): ScorecardMarkerDefinition {
  return {
    id,
    checks: checkIds.map((checkId, index) => ({
      id: checkId,
      mandatory: mandatoryIndexes.includes(index + 1),
    })),
  };
}
