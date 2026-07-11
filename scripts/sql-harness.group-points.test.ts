import { registerGroupPointsConcurrencySuite } from './sql-harness/group-points-concurrency-suite.js';
import { registerGroupPointsEligibilitySuite } from './sql-harness/group-points-eligibility-suite.js';
import { registerGroupPointsIntegritySuite } from './sql-harness/group-points-integrity-suite.js';
import { registerGroupPointsSchemaSuite } from './sql-harness/group-points-schema-suite.js';
import { registerGroupPointsScoringSuite } from './sql-harness/group-points-scoring-suite.js';
import { registerGroupPointsSecuritySuite } from './sql-harness/group-points-security-suite.js';
import { registerGroupPointsUpgradeSuite } from './sql-harness/group-points-upgrade-suite.js';

registerGroupPointsSchemaSuite();
registerGroupPointsUpgradeSuite();
registerGroupPointsSecuritySuite();
registerGroupPointsEligibilitySuite();
registerGroupPointsScoringSuite();
registerGroupPointsIntegritySuite();
registerGroupPointsConcurrencySuite();
