export type EvidenceReference = {
  readonly path: string;
  readonly sha256: string;
};

export type ScorecardCheckInput = {
  readonly id: string;
  readonly evidence: readonly EvidenceReference[];
};

export type ScorecardMarkerInput = {
  readonly id: string;
  readonly checks: readonly ScorecardCheckInput[];
};

export type HardGateInput = {
  readonly id: string;
  readonly evidence: readonly EvidenceReference[];
};

export type ReleaseScorecardBundle = {
  readonly schema_version: 1;
  readonly release_commit: string;
  readonly environment: string;
  readonly created_at: string;
  readonly markers: readonly ScorecardMarkerInput[];
  readonly hard_gates: readonly HardGateInput[];
};

export type MachineEvidenceTarget =
  | { readonly kind: 'marker'; readonly marker_id: string; readonly check_id: string }
  | { readonly kind: 'hard_gate'; readonly id: string };

export type MachineEvidenceResult = {
  readonly target: MachineEvidenceTarget;
  readonly outcome: 'passed' | 'failed';
  readonly command_id: string;
  readonly reason_code?: 'check_failed' | 'hard_gate_failed' | 'not_run';
};

export type MachineEvidence = {
  readonly schema_version: 1;
  readonly kind: 'calledit.machine_evidence';
  readonly release_commit: string;
  readonly environment: string;
  readonly captured_at: string;
  readonly results: readonly MachineEvidenceResult[];
};

export type ScorecardValidationOptions = {
  readonly currentGitSha: string;
  readonly now: string;
  readonly readEvidence: (path: string) => Promise<string | null>;
};

export type ScorecardMarkerResult = {
  readonly id: string;
  readonly passed_checks: number;
  readonly required_checks: 10;
  readonly score: number;
  readonly mandatory_passed: boolean;
};

export type ReleaseScorecardResult = {
  readonly schema_version: 1;
  readonly release_commit: string | null;
  readonly environment: string | null;
  readonly markers: readonly ScorecardMarkerResult[];
  readonly hard_gates: {
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
  readonly decision: 'limited_beta_go' | 'no_go';
  readonly failures: readonly ScorecardFailureCode[];
};

export const SCORECARD_FAILURE_CODES = [
  'bundle_malformed',
  'current_commit_invalid',
  'release_commit_mismatch',
  'environment_invalid',
  'timestamp_invalid',
  'bundle_stale',
  'marker_shape_invalid',
  'check_shape_invalid',
  'evidence_missing',
  'evidence_hash_mismatch',
  'evidence_malformed',
  'evidence_stale',
  'evidence_commit_mismatch',
  'evidence_environment_mismatch',
  'evidence_target_invalid',
  'hard_gate_shape_invalid',
] as const;

export type ScorecardFailureCode = (typeof SCORECARD_FAILURE_CODES)[number];
