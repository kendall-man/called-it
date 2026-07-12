import type { AgentPort } from '../ports.js';
import type { Logger } from '../log.js';
import {
  FALLBACK_TEMPLATES,
  type CopyVars,
  type TemplateKey,
} from './fallback-copy.js';

export { FALLBACK_TEMPLATES, type CopyVars, type TemplateKey };

function v(vars: CopyVars, key: string, fallback = ''): string {
  const value = vars[key];
  return value === undefined ? fallback : String(value);
}

export type Say = (key: TemplateKey, vars?: CopyVars) => Promise<string>;

export function renderFallback(key: TemplateKey, vars: CopyVars = {}): string {
  return FALLBACK_TEMPLATES[key](vars);
}

/**
 * Bridge from engine copy keys to the @calledit/agent persona bank
 * (PERSONA_TEMPLATE_KEYS). The agent's templates leave unknown {placeholders}
 * verbatim, so a mapping only fires when every placeholder it needs is
 * present — otherwise we use the local fallback line.
 */
interface AgentMapping {
  agentKey: string;
  agentVars: CopyVars;
}

function has(vars: CopyVars, keys: string[]): boolean {
  return keys.every((key) => vars[key] !== undefined && String(vars[key]).length > 0);
}

const FIXED_PRODUCT_CONTRACT_KEYS: ReadonlySet<TemplateKey> = new Set([
  'intro',
  'help',
  'group_ready',
]);

const AGENT_TEMPLATE_MAP: Partial<Record<TemplateKey, (vars: CopyVars) => AgentMapping | null>> = {
  nudge_priced: (vars) =>
    has(vars, ['claimer', 'quote', 'multiplier'])
      ? {
          agentKey: 'priced_nudge',
          agentVars: { claimer: v(vars, 'claimer'), quote: v(vars, 'quote'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  clarify: (vars) =>
    has(vars, ['claimer', 'question'])
      ? {
          agentKey: 'clarify_question',
          agentVars: { claimer: v(vars, 'claimer'), question: v(vars, 'question') },
        }
      : null,
  counter_offer: (vars) =>
    has(vars, ['claimer', 'reason', 'offer'])
      ? {
          agentKey: 'counter_offer',
          agentVars: { claimer: v(vars, 'claimer'), reason: v(vars, 'reason'), offer: v(vars, 'offer') },
        }
      : null,
  confirm_gate: (vars) =>
    has(vars, ['claimer', 'terms', 'multiplier'])
      ? {
          agentKey: 'confirm_gate',
          agentVars: { claimer: v(vars, 'claimer'), terms: v(vars, 'terms'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  stake_locked: (vars) =>
    has(vars, ['name', 'stake', 'multiplier', 'side'])
      ? {
          agentKey: v(vars, 'side') === 'Backing' ? 'back_ack' : 'doubt_ack',
          agentVars: { user: v(vars, 'name'), amount: v(vars, 'stake'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  var_freeze: (vars) => ({
    agentKey: 'freeze',
    agentVars: { reason: 'VAR check', market: v(vars, 'market', 'this call') },
  }),
  calls_unlocked: (vars) => ({
    agentKey: 'unfreeze',
    agentVars: { market: v(vars, 'market', 'the call') },
  }),
  settle_won: (vars) =>
    has(vars, ['claimer', 'terms', 'payouts', 'url'])
      ? {
          agentKey: 'settlement_receipt_won',
          agentVars: {
            claimer: v(vars, 'claimer'),
            terms: v(vars, 'terms'),
            payouts: v(vars, 'payouts'),
            url: v(vars, 'url'),
          },
        }
      : null,
  settle_lost: (vars) =>
    has(vars, ['claimer', 'terms', 'payouts', 'url'])
      ? {
          agentKey: 'settlement_receipt_lost',
          agentVars: {
            claimer: v(vars, 'claimer'),
            terms: v(vars, 'terms'),
            payouts: v(vars, 'payouts'),
            url: v(vars, 'url'),
          },
        }
      : null,
  void_market: (vars) => ({
    agentKey: 'void_refund',
    agentVars: { reason: v(vars, 'reason', 'the match got away from us') },
  }),
  insufficient_rep: (vars) =>
    has(vars, ['user', 'balance'])
      ? {
          agentKey: 'insufficient_rep',
          agentVars: { user: v(vars, 'user'), balance: v(vars, 'balance') },
        }
      : null,
  pick_a_lane: (vars) =>
    has(vars, ['user']) ? { agentKey: 'pick_a_lane', agentVars: { user: v(vars, 'user') } } : null,
  slate_intro: (vars) =>
    has(vars, ['fixtures'])
      ? {
          agentKey: 'morning_slate',
          agentVars: { fixtures: v(vars, 'fixtures'), pending: v(vars, 'pending', ' ') },
        }
      : null,
  table_header: (vars) =>
    has(vars, ['groupTitle'])
      ? { agentKey: 'leaderboard_header', agentVars: { groupName: v(vars, 'groupTitle') } }
      : null,
};

export function createSay(agent: AgentPort, log: Logger): Say {
  return async (key, vars = {}) => {
    if (FIXED_PRODUCT_CONTRACT_KEYS.has(key)) return renderFallback(key, vars);
    const mapping = AGENT_TEMPLATE_MAP[key]?.(vars) ?? null;
    if (mapping) {
      try {
        const line = await agent.persona(mapping.agentKey, mapping.agentVars);
        if (typeof line === 'string' && line.trim().length > 0) return line;
      } catch (error) {
        log.warn('persona_fallback', {
          templateKey: key,
          reason: error instanceof Error ? 'persona_exception' : 'unknown_exception',
        });
      }
    }
    return renderFallback(key, vars);
  };
}
