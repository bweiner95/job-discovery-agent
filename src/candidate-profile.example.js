// ─────────────────────────────────────────────────────────────────────────────────
// CANDIDATE PROFILE — EXAMPLE FILE
//
// This file shows what a complete, well-written profile looks like.
// The fictional "Alex Chen" example below demonstrates the level of
// detail that produces accurate scoring.
//
// TO GET STARTED:
//   Run:  npm run setup
//
// The setup wizard will ask you questions and generate your personal
// src/candidate-profile.js automatically. No manual editing required.
//
// If you prefer to set up manually:
//   1. Copy this file:  cp src/candidate-profile.example.js src/candidate-profile.js
//   2. Replace ALL of the content below with your own background
//   3. candidate-profile.js is git-ignored — your data stays local
//
// TIPS FOR ACCURATE SCORING:
//   • Include real company names, titles, and dates
//   • Add quantified achievements where possible (revenue, users, %, $)
//   • Be specific about what you want to AVOID — as important as what you want
//   • List every title variant you'd consider (they vary a lot across companies)
// ─────────────────────────────────────────────────────────────────────────────────

export const CANDIDATE_PROFILE = `
CANDIDATE: Alex Chen
TOTAL EXPERIENCE: ~8 years

WORK HISTORY (most recent first):

1. DUOLINGO — Senior Manager, Growth Strategy & Operations (Jan 2023 – Present, Pittsburgh PA / Remote)
   Scope: Senior IC leading growth strategy for the core learning product (500M+ registered users)
   - Owns DAU/MAU growth strategy across free tier; drove 12% YoY DAU improvement in 2024
   - Built the first-ever cross-functional growth operating cadence: weekly leadership reviews,
     monthly growth council, quarterly OKR alignment across product, marketing, and data science
   - Led a 6-month initiative to redesign the streak mechanics system; resulted in +8% 30-day
     retention improvement across English learners (company's largest segment)
   - Partners directly with VP Product and CPO on strategic planning and board-level narratives
   - Manages a $4M experimentation budget; owns prioritization framework for 40+ active A/B tests
   - Tools: SQL, Amplitude, Looker, Python (light), Figma

2. HINGE — Growth Strategy Manager (Mar 2021 – Dec 2022, New York NY)
   - Designed and launched Hinge's re-engagement strategy, reducing 90-day churn by 18%
   - Led cross-functional teams across product, engineering, and CRM to ship 6 lifecycle features
   - Built revenue forecasting models that informed a $25M annual marketing budget allocation
   - Partnered with data science to develop a propensity-to-churn model (74% accuracy);
     used to trigger personalized re-engagement flows for 3M+ at-risk users

3. MCKINSEY & COMPANY — Business Analyst → Consultant (Jul 2018 – Feb 2021, New York NY)
   - Delivered 8 engagements across consumer digital, telecom, and retail sectors
   - Led a digital growth strategy for a top-5 US wireless carrier; identified $600M+ in
     incremental revenue opportunities from cross-sell and digital channel migration
   - Built a market-entry model for a consumer fintech client expanding into Latin America;
     recommended 3-country rollout sequence adopted by the CEO and board

WHAT MAKES THIS CANDIDATE DISTINCTIVE:
  • Rare combination of consulting rigor and operator experience at consumer tech companies
  • Owns full-funnel growth metrics (acquisition through retention) — not just one slice
  • Data-driven: writes SQL, runs analysis independently, doesn't rely on data teams for insights
  • Has operated at both scale (Duolingo, 500M users) and early stage (Hinge pre-hypergrowth)
  • Cross-functional range: works fluidly with product, engineering, data science, finance, and exec team
  • Built 0→1 processes (growth council, OKR frameworks, experimentation prioritization)

TARGET ROLES (strong match):
  Head of Growth, Director of Growth, VP Growth, Senior Director of Growth,
  Head of User Growth, Director of User Growth, Senior Manager Growth Strategy,
  Director of Strategy & Operations, Head of Strategy & Operations,
  Head of Product Strategy, Growth Strategy Lead, Head of Retention

IDEAL COMPANY PROFILES:
  • Consumer tech companies where DAU/MAU retention and engagement are core success metrics
  • Mobile-first products: social, health/wellness, gaming, dating, productivity, entertainment
  • Companies at the intersection of product-led growth and performance marketing
  • Series B through large public companies — growth function must be a real, staffed team
  • Strong preference for data-driven cultures with mature experimentation programs

NOT A GOOD FIT:
  • Pure B2B or enterprise SaaS with no consumer product
  • Companies where "growth" means sales/revenue ops only (no product growth component)
  • Healthcare, biotech, legal, or government sectors
  • Roles that are primarily people management without strategic scope (20+ directs, purely operational)
  • Early-stage pre-product-market-fit startups where the role is undefined

SALARY TARGET: $200,000+ base
LOCATIONS: New York, NY · San Francisco Bay Area · Remote-friendly hybrid
  — Fully remote considered for roles at strong companies with excellent scope
`.trim();

// ─────────────────────────────────────────────────────────────────────────────────
// SCORING RUBRIC
//
// Customize these bands to match your seniority expectations and priorities.
// Claude uses this rubric alongside your profile when scoring each job 1–10.
// ─────────────────────────────────────────────────────────────────────────────────

export const SCORING_RUBRIC = `
YEARS-OF-EXPERIENCE GATE (apply FIRST, before any other rule):
  Candidate has ~8 years of total experience.   /* ← edit to match yours */
  Always check the JD for an explicit minimum YOE requirement
  ("X+ years", "minimum X years", "at least X years"). YOE takes
  priority over title — a strong title cannot rescue a YOE mismatch.

  • JD requires ≤ 7 years       → no penalty
  • JD requires 8–9 years       → no penalty (perfect match)
  • JD requires 10 years        → cap final score at 7 (mild stretch)
  • JD requires 11–12 years     → cap final score at 5 (significant gap)
  • JD requires 13+ years       → cap final score at 3
  • JD requires 15+ years (VP)  → cap final score at 2

  If JD doesn't state YOE: infer from title (Director ≈ 10+, Sr Director ≈ 12+,
  VP ≈ 15+) and apply the cap above.

  Re-anchor the YOE numbers above to your actual years.

SCORE 9–10 (near-perfect): All of the following are true —
  • Title is Senior Manager/Director/VP/Head of [Growth, User Growth, Retention,
    Strategy & Ops, Product Growth, or Growth Strategy]
  • Company is a consumer-facing tech company with meaningful scale (DAU/MAU matter)
    Examples: social, health/wellness, marketplace, gaming, entertainment, dating apps
  • Location is New York or SF Bay Area (or remote-friendly)
  • Description signals a data-driven, product-led culture with real experimentation
  • Role involves both strategy AND execution ownership — not just advisory

SCORE 7–8 (strong match): Most of the following are true —
  • Title is right function but seniority is slightly off (e.g. Manager vs. Senior Manager,
    or SVP if scope is appropriate), OR title wording varies but role is clearly growth/strategy
  • Company is consumer-facing but adjacent to ideal (fintech with consumer product,
    B2C SaaS, large DTC brand, or well-known consumer platform)
  • Location matches or remote option is available
  • Some evidence of metrics ownership or data-driven culture in the description

SCORE 5–6 (moderate fit): One or more meaningful gaps —
  • Right function but primarily a B2B company — consumer angle is thin or unclear
  • Right company but role is too narrowly operational (e.g. campaign ops, channel ops)
  • Geography is ambiguous or city isn't in target list

  NOTE ON TITLE: "Manager" alone is NOT a downgrade. Treat any title (Manager, Senior
  Manager, Lead, Director, Head) as a fit if the JD's stated YOE requirement aligns
  with your years AND the salary is at or near your floor. Only penalize a title when
  scope reads as execution-only (e.g., "campaign manager," "account manager") or when
  the YOE/salary signal is clearly below your level.

SCORE 1–4 (poor fit): Any of these —
  • Wrong function: sales ops, revenue ops, finance, HR, engineering, pure data science
  • Industry mismatch: healthcare, biotech, legal, government, pure enterprise
  • Clearly too junior (analyst, associate, coordinator) or too senior (C-suite executive)
  • No consumer product element whatsoever
  • Outside target geography with no remote option stated

SALARY GUIDANCE:
  If salary is listed and clearly below $175K, deduct 1–2 points.
  If salary is not listed, do NOT penalize — most senior roles omit it.
  If salary is listed at $200K+, note it as a positive signal in the reason.

NOTE: When in doubt between 6 and 7 for a consumer tech company, choose 7.
A missed great opportunity is worse than reviewing one borderline result.
`.trim();
