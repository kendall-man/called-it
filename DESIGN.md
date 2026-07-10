# Called It Design Contract

This file records both the audited current web baseline and the approved visual and
interaction target for the direct SOL beta. It preserves the match-night character while
making action, state, privacy, and recovery clear before personality. It does not claim
that the current implementation already complies. UI changes must follow the approved
target unless a later recorded design decision replaces a rule.

## Audited Current Baseline

The 2026-07-10 audit found the following implementation details. They are design debt,
not exceptions to the target contract.

| Current implementation | Status and planned migration |
| --- | --- |
| Shared `Card` and receipt/action surfaces use `rounded-2xl` (16px radius). | Audited debt. Task 22 applies the approved 8px maximum across active surfaces. |
| The page background uses two decorative radial gradients. | Audited debt. Task 22 removes decorative gradients while retaining the canonical palette. |
| `.display-type` uses `letter-spacing: -0.015em`; several components also use `tracking-tight`, `tracking-wider`, or positive arbitrary tracking. | Audited debt. Task 22 moves active UI text to zero letter spacing. |
| The landing primary action uses `hover:scale-[1.01]`. | Audited debt. Task 22 replaces hover scaling with non-layout-shifting state feedback. |
| Public receipt and group rows render raw `quotedText` and `claimerName`. | Privacy and content debt. Task 21 replaces them with deterministic compiled terms and the confirmed speaker's stable group alias. |
| The landing action uses a fixed versioned Telegram bot link as an interim destination. | Functional interim state. Task 19 derives the same versioned group-add link from validated environment configuration and completes the landing flow. |

Task 20 builds the account surface against this target. Task 22 performs the final
cross-surface accessibility, language, motion, shape, and recovery migration after Tasks
19-21 establish the required product surfaces.

## Product Character

Called It should feel like a floodlit football broadcast: near-black surfaces, chalk
text, pitch green for committed success, floodlight amber for pending states, siren red
for refusal or loss, and sky blue for neutral proof detail. It is a compact product
surface, not a marketing site or an analytics dashboard.

- Put the product name, current call, amount, and next action ahead of atmosphere.
- Keep Callie's football personality in supporting copy after status and action are clear.
- Use literal B1-level language on the critical path. Explain technical proof detail only
  in an expandable trust section.
- No demo or replay onboarding, decorative blobs, fake receipts, nested cards, or
  instructional feature tours.

## Approved Target

Everything below is the required destination for new work and the scheduled migrations
above. It is not a statement that the audited baseline already passes these rules.

## Foundations

### Color

These values are derived from `apps/web/app/globals.css` and remain the canonical palette.

| Token | Value | Use |
| --- | --- | --- |
| `night-950` | `#05070b` | Page background |
| `night-900` | `#0a0f16` | Primary contained surface |
| `night-800` | `#101723` | Raised control or secondary surface |
| `night-700` | `#18202f` | Hover/selected neutral surface |
| `line` | `#223047` | Borders and dividers |
| `chalk` | `#f2f6fc` | Primary text |
| `fog` | `#8fa0b8` | Secondary text; never critical text on `night-950` |
| `pitch-300` | `#6ef0ac` | Success text |
| `pitch-500` | `#16c86f` | Primary action and success border |
| `flood-300` | `#ffe08a` | Pending text |
| `flood-500` | `#f0b90b` | Pending border or indicator |
| `siren-300` | `#ff8095` | Error/loss text |
| `siren-500` | `#f43f5e` | Error/loss border or indicator |
| `sky-400` | `#5ab8ff` | Link and proof detail |

Color never carries status by itself. Pair it with a plain label and, where useful, a
familiar icon. Body text and controls must meet WCAG AA contrast; focus indicators must
reach at least 3:1 against adjacent colors. Decorative background gradients are retired.

### Typography

- Body: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, sans-serif`.
- Display: `"Avenir Next Condensed", "Helvetica Neue Condensed", "Arial Narrow",
  "Helvetica Neue", Arial, ui-sans-serif, sans-serif`.
- Display text may be uppercase and weight 800. Letter spacing is always `0`.
- Use one `h1` per page, then ordered headings. Reserve 48-72px display text for the
  landing product name; compact tools and cards use 14-24px headings.
- Critical status, balance, amount, and action text is at least 14px. Supporting metadata
  may be 12px only when it is not required to complete or understand an action.
- Font size is selected by component and breakpoint, never scaled continuously with the
  viewport.

### Spacing And Shape

Use a 4px base scale: `4, 8, 12, 16, 24, 32, 48, 64`. The default page gutter is 16px,
increasing to 24px at 640px. Reading and receipt surfaces use a 576px maximum width;
boards may widen only when the additional width carries scannable data.

- Cards and framed tools use a maximum 8px radius and a 1px `line` border.
- Do not place a card inside another card or style a full page section as a floating card.
- Buttons and inputs have a minimum 44px target in both dimensions.
- Stable controls, tiles, counters, and offer rows declare fixed or minimum dimensions so
  loading, hover, translated copy, and live values do not shift the layout.

## Interaction

### Focus And Keyboard

Every interactive element has a visible 2px focus ring with a 2px offset. Use
`pitch-300` on dark surfaces and `night-950` on a `pitch-500` primary action. Focus order
follows reading order; modals trap and restore focus; no action requires pointer input.
Never remove an outline without providing this replacement.

### Motion

Motion confirms a state change; it never delays an action or supplies the only status cue.
Color, border, and opacity transitions run for 120-180ms with standard ease-out. Avoid
hover scaling, looping decoration, parallax, and layout animation. Under
`prefers-reduced-motion: reduce`, remove nonessential transitions and scrolling effects;
state changes remain immediate and announced.

### Responsive Behavior

The product must reflow without horizontal page scroll at 320px and remain usable at 200%
text zoom. Build mobile-first, add a two-column layout only when each column keeps its
minimum readable width, and collapse dense board rows into labelled definition groups on
narrow screens. Long team names, aliases, amounts, proof states, and errors wrap without
covering adjacent content. The landing first viewport shows the primary add action and a
visible hint of real group or receipt content at 375x812 and wide desktop sizes.

## Components

### Commands And Links

Use an icon button with a tooltip for familiar utilities such as close, copy, refresh, and
back. Use text or icon-plus-text for commands whose outcome needs a label. Links navigate;
buttons mutate or reveal state. Every CTA has a real destination; hash-only placeholder
destinations are forbidden.

### Offer

An offer has deterministic compiled terms, timing, aggregate pot state, and exactly these
top-level actions:

1. `It happens · 0.01 SOL`
2. `It does not · 0.01 SOL`
3. `Choose amount`

The first two are equal primary rows. `Choose amount` is secondary and opens a scoped
0.05/0.10 SOL picker. Pending, matched, closed, and refused states replace the action area
without changing the card width.

### Status, Errors, And Recovery

Every failure or interruption states three things in this order:

1. What happened.
2. Whether SOL or saved state changed.
3. One next action.

Do not rely on a toast, color, animation, or raw reason code. Preserve safe user state
through recovery and announce asynchronous updates in a polite live region.

### Account, Board, And Receipt

- `/me` and the account surface are private: test-SOL balance, verified wallet state, and
  the requesting member's positions only.
- `/table` is a group board: active calls, aggregate happens/does-not pots, matched amount,
  timing, and recent receipts. It never ranks a points economy.
- A public receipt identifies the confirmed speaker only by their stable per-group alias.
  It renders terms from the deterministic compiled market specification, never raw chat
  text, and shows aggregate SOL, outcome, refund/payout state, participant count, and an
  honest proof status.

### Starter Notice

The first eligible 0.01 test-SOL position may be funded by a limited starter grant. The
grant is treasury-backed, disabled by default, once per verified Telegram identity, and
created only in the same atomic operation as that first position. It has no monetary value
and is not a separate reward or guaranteed entitlement. Never describe starter funds as
practice, demo, or free money.

## Review Checklist

- One clear primary action and one `h1` per page.
- SOL/test SOL is the only current economy.
- Speaker consent is visible before a passively detected call becomes public.
- Focus, keyboard, reduced-motion, contrast, 320px reflow, and 200% text zoom pass.
- No overlap, clipped text, nested cards, placeholder destinations, or color-only status.
- Public surfaces contain stable aliases, compiled terms, and aggregates only.
- Every failure follows the three-part recovery pattern.
