# Release Scorecard

`scripts/release-scorecard.ts` validates the Appendix D 14-marker, 140-check scorecard without
accepting manually entered scores. It prints exactly `limited_beta_go` or `no_go`.

```sh
npx -y pnpm@10.33.0 exec tsx scripts/release-scorecard.ts \
  --bundle evidence/release-scorecard.json \
  --current-git-sha <full-40-character-git-sha> \
  --now 2026-07-11T10:00:00.000Z
```

The bundle contains every named marker/check and each check references one or more relative,
SHA-256-addressed machine-evidence files. An evidence file has the strict
`calledit.machine_evidence` shape: reviewed commit, environment, canonical capture timestamp,
and machine pass/fail results targeted to marker checks or named hard gates. Scores, pass counts,
decisions, human overrides, extra fields, stale/future evidence, path traversal, hash mismatches,
commit/environment mismatches, missing targets, and duplicate marker/check/gate entries are all
`no_go`.

Evidence is fresh only for 24 hours at the supplied deterministic `--now` instant. All 13 named
hard gates must pass, every mandatory check must pass, and every marker must compute to at least
9.0. The validator reads artifacts only and cannot enable a rollout switch.
