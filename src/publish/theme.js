/**
 * The stylesheet, as one string.
 *
 * Aesthetic brief: a printed bulletin from a measurement bureau — ruled paper,
 * hairline rules, an oversized serif masthead over dense monospaced telemetry.
 * The registry publishes machine facts, so the page is typeset like a record of
 * instrument readings rather than like a SaaS landing page: no cards floating
 * on white, no gradient hero, no rounded pill buttons.
 *
 * Vermilion is reserved exclusively for `breaking`. It appears nowhere else on
 * the page, so a reader scanning from across the room learns the only thing
 * that actually matters before reading a single word.
 */
export const STYLESHEET = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root {
  --paper: #ece6d8;
  --paper-deep: #e2dbc9;
  --ink: #17150f;
  --ink-soft: #4a4535;
  --ink-faint: #8c8571;
  --rule: #c8c0aa;
  --rule-hair: #d6cfbc;
  --breaking: #b4361a;
  --additive: #2c6249;
  --cosmetic: #7d7663;
  --operational: #4a5b6b;
  --stamp: #b4361a;
  --measure: 74rem;
  --measure-text: 46rem;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  line-height: 1.55;
  font-variant-ligatures: none;
}

/* Paper grain. Fixed, so scrolling does not shear the texture. */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9;
  opacity: 0.42;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.35'/%3E%3C/svg%3E");
}

.wrap { max-width: var(--measure); margin: 0 auto; padding: 0 clamp(1rem, 4vw, 3rem); }

a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--breaking); }

code, .mono { font-family: inherit; }

/* --- masthead ------------------------------------------------------------ */

.masthead {
  border-bottom: 2px solid var(--ink);
  padding: clamp(2rem, 6vw, 4.5rem) 0 1rem;
  position: relative;
}
.masthead__kicker {
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--ink-faint);
  display: flex;
  gap: 1.25rem;
  flex-wrap: wrap;
  margin-bottom: clamp(1.5rem, 4vw, 3rem);
}
.masthead__title {
  font-family: 'Instrument Serif', 'Iowan Old Style', Georgia, serif;
  font-weight: 400;
  font-size: clamp(3.2rem, 13vw, 9.5rem);
  line-height: 0.84;
  letter-spacing: -0.02em;
  margin: 0;
  text-wrap: balance;
}
.masthead__title em { font-style: italic; color: var(--breaking); }
.masthead__lede {
  margin: clamp(1.25rem, 3vw, 2rem) 0 0;
  max-width: 46ch;
  font-size: 15px;
  color: var(--ink-soft);
}
.masthead__lede strong { color: var(--ink); font-weight: 600; }
/* Set as a margin note, not as a warning: a sampling caveat earns a rule and a
   smaller size, not the red the page saves for broken contracts. */
.masthead__caveat {
  margin: 0.9rem 0 0;
  max-width: 46ch;
  padding-left: 0.9rem;
  border-left: 2px solid var(--operational);
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.masthead__caveat strong { color: var(--operational); font-weight: 600; }
.notice {
  margin: 1.1rem 0 0;
  max-width: 62ch;
  padding-left: 0.9rem;
  border-left: 2px solid var(--operational);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.notice strong { color: var(--ink); font-weight: 600; }
.notice .flag { margin: 0 0.35rem 0 0; }

/* How a record was read is routine metadata and is set as such: a hairline
   rule, no colour, no alarm. It is on the page because it must be checkable,
   not because it is news. */
.notice--method { border-left-color: var(--rule); color: var(--ink-faint); }
.notice--method code { color: var(--ink-soft); }
.notice--method .stamp { color: var(--ink-faint); border-color: var(--rule); }

/* "This is not an observation" is a defect in our own instrument, not a
   breaking change in somebody's contract — so it must be impossible to miss
   and must not borrow the vermilion reserved for contract damage. It gets the
   hatching a clerk rules across a voided entry. */
.notice--suspect {
  border-left: 2px solid var(--ink);
  color: var(--ink);
  padding: 0.7rem 0.9rem;
  background-image: repeating-linear-gradient(
    -45deg,
    transparent 0 6px,
    rgba(23, 21, 15, 0.055) 6px 7px
  );
}
.notice--suspect .stamp { color: var(--ink); border-color: var(--ink); }
.masthead__grid { display: grid; gap: clamp(1.25rem, 4vw, 4rem); align-items: end; }
@media (min-width: 62rem) {
  .masthead__grid { grid-template-columns: minmax(0, 1.35fr) minmax(16rem, 0.65fr); }
  .masthead__lede { margin-top: 0; }
}

/* Severity key — doubles as the legend for every chip on the site. */
.key { border-top: 1px solid var(--ink); padding-top: 0.9rem; }
.key__row { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.3rem 0; font-size: 12px; color: var(--ink-soft); }
.key__row .sev { flex: 0 0 auto; }

/* --- readout strip ------------------------------------------------------- */

.readout {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  border-bottom: 1px solid var(--ink);
}
.readout__cell {
  padding: 1.1rem 0 1.2rem;
  border-right: 1px solid var(--rule-hair);
  padding-right: 1rem;
}
.readout__cell:last-child { border-right: 0; }
.readout__value {
  font-family: 'Instrument Serif', Georgia, serif;
  font-size: 2.6rem;
  line-height: 1;
  display: block;
}
.readout__label {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.readout__cell--alarm .readout__value { color: var(--breaking); }
/* Red is spent only on contract damage. Sampling caveats read in slate. */
.readout__cell--aside .readout__value { color: var(--operational); }

/* --- sections ------------------------------------------------------------ */

section { padding: clamp(2.5rem, 6vw, 4.5rem) 0; border-bottom: 1px solid var(--rule); }
section:last-of-type { border-bottom: 0; }

.section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.75rem;
}
h2 {
  font-family: 'Instrument Serif', Georgia, serif;
  font-weight: 400;
  font-size: clamp(1.9rem, 4vw, 2.9rem);
  line-height: 1;
  margin: 0;
}
h2 .num {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.2em;
  vertical-align: super;
  color: var(--ink-faint);
  margin-right: 0.6rem;
}
.section__note { font-size: 12px; color: var(--ink-faint); max-width: 42ch; }

/* --- events -------------------------------------------------------------- */

.event {
  display: grid;
  grid-template-columns: 8.5rem 1fr;
  gap: 0 1.5rem;
  padding: 1.15rem 0;
  border-top: 1px solid var(--rule-hair);
  position: relative;
}
.event:first-child { border-top: 1px solid var(--ink); }
.event__when { font-size: 11px; color: var(--ink-faint); letter-spacing: 0.04em; padding-top: 0.15rem; }
.event__body { min-width: 0; }
.event__line { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.event__server { font-weight: 600; letter-spacing: -0.01em; }
.event__summary { color: var(--ink-soft); }
.event__summary code {
  background: var(--paper-deep);
  padding: 0.05em 0.35em;
  border-bottom: 1px solid var(--rule);
  color: var(--ink);
}

.sev {
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.25em 0.5em 0.2em;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.sev--breaking { color: var(--breaking); }
.sev--additive { color: var(--additive); }
.sev--cosmetic { color: var(--cosmetic); }
.sev--operational { color: var(--operational); }

/* The one thing a reader should remember. */
.stamp {
  display: inline-block;
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--stamp);
  border: 1.5px solid var(--stamp);
  padding: 0.3em 0.55em 0.25em;
  transform: rotate(-3.5deg);
  opacity: 0.9;
  box-shadow: inset 0 0 0 3px rgba(180, 54, 26, 0.08);
}

.changes {
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  border-left: 2px solid var(--rule);
  padding-left: 0.9rem;
}
.changes li { display: flex; gap: 0.75rem; padding: 0.15rem 0; color: var(--ink-soft); }
.changes__kind { color: var(--ink-faint); min-width: 11rem; }
.changes__path { color: var(--ink); }

/* --- ledger table -------------------------------------------------------- */

.ledger { width: 100%; border-collapse: collapse; font-size: 13px; }
.ledger th {
  text-align: left;
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-faint);
  font-weight: 500;
  padding: 0 0.75rem 0.6rem 0;
  border-bottom: 1px solid var(--ink);
}
.ledger td { padding: 0.7rem 0.75rem 0.7rem 0; border-bottom: 1px solid var(--rule-hair); vertical-align: baseline; }
.ledger tr:hover td { background: rgba(180, 54, 26, 0.045); }
.ledger__num { text-align: right; font-variant-numeric: tabular-nums; }
.ledger__name { font-weight: 600; }
.ledger__vendor { color: var(--ink-faint); font-size: 11px; }
.ledger__fp { color: var(--ink-faint); font-size: 11px; letter-spacing: 0.02em; }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 0.45rem; vertical-align: middle; }
.dot--ok { background: var(--additive); }
.dot--error { background: var(--breaking); }
.dot--auth_required { background: var(--cosmetic); }
/* Hollow, not filled: the state is "we cannot say", which is neither of the
   two solid answers on either side of it. */
.dot--unstable { background: transparent; box-shadow: inset 0 0 0 1.5px var(--operational); }

/* A quarantined host is a caveat about the instrument, not an alarm about a
   contract. It gets slate, lower case and a dotted rule — intermittent by
   drawing, and deliberately quieter than the red reserved for real breakage. */
.flag {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 500;
  color: var(--operational);
  border-bottom: 1.5px dotted var(--operational);
  padding-bottom: 0.1em;
  margin-left: 0.35rem;
  white-space: nowrap;
}
.ledger__row--quarantined .ledger__name a { color: var(--ink-soft); }

/* --- census: a register, not a bulletin ---------------------------------- */
/*
   Fifty-one rows read at a reading measure. The ledger's rhythm is wrong here:
   the ledger is scanned for the one row that moved, the census is looked up by
   name and then read across. So the rows tighten, the header stays put while
   the eye travels, and the only thing carrying weight is the answer the reader
   came for — which of the variants this tenant serves.
*/
/* The one element allowed out of the reading measure. A register of fifty-odd
   rows set to 46rem is cramped for no reason; a printed report would fold this
   one table out wider than its own column, so this one does. */
.census__spread {
  width: min(var(--measure), calc(100vw - 2 * clamp(1rem, 4vw, 3rem)));
  margin-left: 50%;
  transform: translateX(-50%);
}
.census { font-size: 12.5px; margin-top: 1.4rem; }
.census th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--paper);
  padding-top: 0.7rem;
}
.census td { padding: 0.5rem 0.75rem 0.5rem 0; }
.census .ledger__name { font-weight: 500; }
.census .ledger__name a { text-decoration: none; border-bottom: 1px solid var(--rule); }
.census .ledger__name a:hover { border-bottom-color: var(--ink); }

/* The distinguishing cell. A tenant with no extra parameters is the majority
   case and recedes to a dash; anything else is boxed, so a reader scrolling
   the register sees the exceptions without reading a word. */
.census__variant code {
  display: inline-block;
  font-size: 11px;
  border: 1px solid var(--rule);
  background: var(--paper-deep);
  padding: 0.05rem 0.35rem;
  margin: 0 0.25rem 0.1rem 0;
}
.census__none { color: var(--ink-faint); }

/* Variant number, set as a call-number: the reader carries it back up to the
   table in section 02 and nowhere else. */
.census .ledger__num { color: var(--ink-faint); font-size: 11px; }
.census .ledger__num::before { content: 'V'; letter-spacing: 0.1em; }
.census thead .ledger__num::before { content: ''; }

/* --- prose + panels ------------------------------------------------------ */

.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: clamp(1.5rem, 4vw, 3rem); }
.panel__title {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.5rem;
  margin-bottom: 0.9rem;
}
.panel p { margin: 0 0 0.8rem; color: var(--ink-soft); font-size: 13px; }
.panel p:last-child { margin-bottom: 0; }
.panel strong { color: var(--ink); font-weight: 600; }

.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1.2rem; }
.btn {
  display: inline-block;
  border: 1px solid var(--ink);
  padding: 0.55rem 1rem;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-decoration: none;
  transition: background 120ms linear, color 120ms linear;
}
.btn:hover { background: var(--ink); color: var(--paper); }
.btn--accent { border-color: var(--breaking); color: var(--breaking); }
.btn--accent:hover { background: var(--breaking); color: var(--paper); }

pre {
  background: var(--paper-deep);
  border-left: 2px solid var(--rule);
  padding: 0.9rem 1rem;
  overflow-x: auto;
  font-size: 12px;
  margin: 0;
}

/* --- tools --------------------------------------------------------------- */

.tool { border-top: 1px solid var(--rule-hair); padding: 1.1rem 0; }
.tool:first-child { border-top: 1px solid var(--ink); }
.tool__head { display: flex; gap: 0.75rem; align-items: baseline; flex-wrap: wrap; }
.tool__name { font-weight: 600; }
.tool__fp { font-size: 11px; color: var(--ink-faint); }
.tool__desc { color: var(--ink-soft); margin: 0.35rem 0 0; max-width: 78ch; font-size: 13px; }
.tool__params { margin: 0.6rem 0 0; padding: 0; list-style: none; font-size: 12px; }
.tool__params li { display: flex; gap: 0.6rem; padding: 0.1rem 0; }
.tool__param { color: var(--ink); min-width: 14rem; }
.tool__type { color: var(--ink-faint); }
.req { color: var(--breaking); font-size: 9px; letter-spacing: 0.14em; }

/* --- note: an offprint of the bulletin, set to a reading measure ---------- */

.wrap--text { max-width: var(--measure-text); }

.note__head {
  border-bottom: 2px solid var(--ink);
  padding: clamp(2.5rem, 7vw, 5rem) 0 1.6rem;
}
.note__kicker {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.4rem;
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.7rem;
  margin-bottom: clamp(1.4rem, 4vw, 2.4rem);
}
.note__title {
  font-family: 'Instrument Serif', Georgia, serif;
  font-weight: 400;
  font-size: clamp(2.6rem, 8vw, 4.6rem);
  line-height: 0.94;
  letter-spacing: -0.015em;
  margin: 0 0 1.4rem;
}
.note__title em { font-style: italic; color: var(--breaking); }

/* A hanging rule down the standfirst: the one thing that says "insert". */
.note__standfirst {
  margin: 0 0 1.6rem;
  padding-left: 1.1rem;
  border-left: 2px solid var(--breaking);
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink-soft);
  max-width: 58ch;
}
.note__meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--ink-faint);
}
.note__meta span:last-child { max-width: 46ch; }

.note section { padding: clamp(2rem, 5vw, 3.2rem) 0; }
.note h2 { font-size: clamp(1.6rem, 4vw, 2.3rem); margin-bottom: 1.2rem; }
.note p { margin: 0 0 1rem; color: var(--ink-soft); max-width: 68ch; }
.note p strong { color: var(--ink); font-weight: 600; }
.note pre { margin: 1.2rem 0; }
.note .actions { margin-top: 1.8rem; }

.note__list { list-style: none; margin: 1rem 0 1.2rem; padding: 0; }
.note__list li {
  display: flex;
  gap: 0.9rem;
  flex-wrap: wrap;
  padding: 0.45rem 0;
  border-top: 1px solid var(--rule-hair);
  font-size: 13px;
  color: var(--ink-soft);
}
.note__list li:first-child { border-top: 1px solid var(--ink); }
.note__list code { color: var(--ink); font-weight: 600; }

/* --- figure: one measure, one ink, values direct-labelled ---------------- */

.figure { margin: 1.6rem 0 1.8rem; }
.figure__cap {
  caption-side: bottom;
  text-align: left;
  font-size: 11px;
  color: var(--ink-faint);
  padding-top: 0.9rem;
  max-width: 56ch;
}
.strata { width: 100%; border-collapse: separate; border-spacing: 0 2px; }
.strata th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--ink-faint);
  letter-spacing: 0.02em;
  width: 17rem;
  padding-right: 0.9rem;
  vertical-align: top;
  line-height: 1.35;
}
.strata__props { display: block; color: var(--ink); white-space: nowrap; }
.strata__props code { font-size: 11px; }
.strata__props code + code::before { content: ', '; color: var(--ink-faint); }
.strata__fp { display: block; font-size: 10px; color: var(--ink-faint); letter-spacing: 0.04em; }
.strata__cell { vertical-align: top; padding-top: 2px; }
.strata__cell {
  width: 100%;
  border-left: 1px solid var(--ink);
  padding: 0 0.75rem 0 0;
  line-height: 0;
}
.strata__bar {
  display: inline-block;
  height: 10px;
  min-width: 3px;
  background: var(--ink);
  border-radius: 0 4px 4px 0;
}
.strata tr:hover .strata__bar { background: var(--breaking); }
.strata__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--ink);
  padding-left: 0.6rem;
  white-space: nowrap;
}

/* --- footer -------------------------------------------------------------- */

footer {
  border-top: 2px solid var(--ink);
  padding: 2rem 0 3.5rem;
  font-size: 11px;
  color: var(--ink-faint);
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.crumb { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-faint); padding-top: 2rem; display: block; }

.empty { color: var(--ink-faint); font-size: 13px; padding: 1.5rem 0; border-top: 1px solid var(--ink); }

/* --- one orchestrated reveal, then the page stays still ------------------- */

@media (prefers-reduced-motion: no-preference) {
  .reveal { animation: rise 620ms cubic-bezier(0.16, 0.84, 0.28, 1) both; }
  .reveal:nth-child(1) { animation-delay: 40ms; }
  .reveal:nth-child(2) { animation-delay: 90ms; }
  .reveal:nth-child(3) { animation-delay: 140ms; }
  .reveal:nth-child(4) { animation-delay: 190ms; }
  .reveal:nth-child(5) { animation-delay: 240ms; }
  .reveal:nth-child(n+6) { animation-delay: 290ms; }
}
@keyframes rise {
  from { opacity: 0; transform: translateY(0.6rem); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 44rem) {
  .event { grid-template-columns: 1fr; gap: 0.35rem; }
  .strata th { width: 10.5rem; font-size: 10px; }
  .changes__kind { min-width: 8rem; }
  .ledger__hide { display: none; }
}
`.trim();
