---
name: job-hunt-setup
description: >
  First-time setup wizard for the Job Discovery Agent. Handles everything:
  reads the user's resume, collects preferences, writes candidate-profile.js,
  updates all location/keyword configs, patches skill files with the project path.
  Trigger on: /job-hunt-setup, "set up job agent", "set up my job search",
  "personalize job hunt", "generate my profile", "configure job agent",
  "first time setup", "initial setup".
---

# Job Hunt — Setup Wizard

Complete first-time setup for the job discovery agent. This skill handles
everything from scratch. Work through each step in order, one at a time.
Wait for the user to respond before moving to the next step.

---

## Step 0 — Check prerequisites

First, get the project path and check the environment:

```bash
pwd && echo "---" && node --version && echo "---" && ls node_modules > /dev/null 2>&1 && echo "node_modules: OK" || echo "node_modules: MISSING — run npm install"
```

Then greet the user and confirm prerequisites before continuing:

```
Before we start, confirm these three things are in place:

1. Node.js 22.15 or higher
   › Run `node --version` in your terminal — need v22.15+

2. npm install has been run in this directory
   › Run `npm install` if you haven't yet

3. Claude in Chrome extension is installed
   › https://claude.ai/download → scroll to "Chrome Extension"
   › Sign in to LinkedIn in Chrome before your first job search

Ready to continue?
```

Wait for the user to confirm before proceeding.

---

## Step 1 — Resume

Ask the user for their resume:

```
Please attach your resume or paste the text directly in chat.

Accepted formats: .pdf · .txt · .md · paste as plain text

The more detail your resume has, the more accurate your job scoring will be.
```

Wait for the user to provide their resume. If they attach a file, read it with the Read tool. If they paste text, capture it from the message.

If they don't have a resume handy, tell them:
```
No problem — I'll ask you questions about your background instead and we'll build the profile from your answers.
```
Then proceed to Step 2 and gather background details through conversation.

---

## Step 2 — Background questions

Ask these questions **one at a time**, waiting for each answer before asking the next.

**2a. Name**
```
What's your full name?
```

**2b. Target titles**
```
What job titles are you targeting? List every variant you'd consider, separated by commas.

Include different seniority levels and wordings — titles for the same role vary a lot across companies.

Examples by field:
  Growth:       Head of Growth, Director of Growth, VP Growth, Senior Manager Growth, Growth Lead
  Product:      Senior PM, Director of Product, Group PM, Head of Product, Principal PM
  Engineering:  Staff Engineer, Principal Engineer, Engineering Manager, Director of Engineering
  Marketing:    VP Marketing, Director of Marketing, Head of Growth Marketing, Senior Marketing Manager
  Finance:      VP Finance, Director of FP&A, Head of Finance, Senior Finance Manager
  Design:       Head of Design, Director of Design, Principal Designer, Design Lead
  Data:         Head of Data, Director of Analytics, VP Data Science, Principal Data Scientist
```

**2c. Target cities**
```
Which cities are you open to? Separate by commas. Add "Remote" to also include remote-friendly roles.

Supported: New York · San Francisco · Los Angeles · Chicago · Austin · Seattle · Boston · Miami · Denver · Atlanta
```

**2d. Salary floor**
```
What's your minimum base salary? Jobs with a listed salary below this will be scored down.
(Enter a number like 150000, or leave blank to skip)
```

**2e. Target companies and industries**
```
What kinds of companies are you targeting? Be specific — this drives how Claude evaluates company fit.

Example: "Consumer tech companies with a large user base (social, marketplace, subscription, gaming). High-growth Series B–D startups where the function is a core driver. DTC brands with meaningful digital operations."
```

**2f. What to avoid**
```
What do you want to filter out? Industries, company types, or roles to deprioritize.

Example: "Pure B2B/enterprise SaaS with no consumer product. Biotech, healthcare, legal, or government sectors. Roles that are primarily people management without strategic scope."
```

**2g. Years of experience**
```
How many years of total professional experience do you have? (e.g., 5, 8, 12)

This is used to build a Years-of-Experience Gate in the scoring rubric. Jobs with
JD requirements significantly above your YOE get auto-deprioritized — a "12+ years"
listing won't waste a slot in your triage view if you have 6 years.
```

---

## Step 3 — Write candidate-profile.js

Using the resume and all answers from Step 2, generate a rich, specific profile. Then write it to `src/candidate-profile.js`.

**Profile writing guidelines:**

- **WORK HISTORY**: For each role, include company name, exact title, dates, city, and 3–5 bullet points. Pull specific achievements and metrics from the resume where visible. Do not fabricate numbers — if a metric isn't in the resume, describe the scope qualitatively.
- **DISTINCTIVE STRENGTHS**: 4–6 bullets, evidence-backed from the resume. Be specific, not generic.
- **TARGET ROLES**: Use the exact titles the user gave in Step 2b, verbatim.
- **IDEAL COMPANIES**: Expand from the user's Step 2e answer based on their background — what types of companies would genuinely value their specific experience?
- **NOT A FIT**: Use the user's Step 2f answer, expand slightly if their background makes other exclusions obvious.
- **SALARY + LOCATIONS**: Use exact numbers/cities from Steps 2c and 2d.

**Search targets — these get exported as separate constants in the same file (not part of CANDIDATE_PROFILE):**

- **`LINKEDIN_SEARCH_URLS`**: Build one URL per city from Step 2c. Each URL pattern:
  `https://www.linkedin.com/jobs/search/?keywords=<URL_ENCODED_TITLES_FROM_2b>&location=<URL_ENCODED_CITY>&f_TPR=r604800`
  Titles should be joined with `+OR+`. The `f_TPR=r604800` is the past-week filter — keep it.

- **`GREENHOUSE_COMPANIES`, `LEVER_COMPANIES`, `ASHBY_COMPANIES`**: From the user's industries answer in Step 2e, suggest 20–60 company slugs per ATS that match their target industries. Use only well-known companies that actually use each ATS. The user can edit later. Verify slugs exist at `boards.greenhouse.io/{slug}` / `jobs.lever.co/{slug}` / `jobs.ashbyhq.com/{slug}` — but don't actually network-check during setup, just use known-good slugs you're confident in.

The scrapers and skill files read these arrays at runtime — no need to edit code or markdown elsewhere.

**SCORING_RUBRIC guidelines:**

- Reference the user's actual target titles in the 9–10 band (not generic placeholders)
- Reference their actual ideal company types in the descriptions
- Reference their actual salary floor in SALARY GUIDANCE
- **Include a YEARS-OF-EXPERIENCE GATE at the top** of the rubric, parameterized to the user's actual YOE from Step 2g. The gate caps the final score when the JD requires significantly more experience than the candidate has. Use this template, replacing `{N}` with the user's number:

  ```
  YEARS-OF-EXPERIENCE GATE (apply FIRST, before any other rule):
    Candidate has ~{N} years of total experience.
    Always check the JD for an explicit minimum YOE requirement
    ("X+ years", "minimum X", "at least X years"). YOE takes priority over
    title — a strong title cannot rescue a YOE mismatch.

    • JD requires ≤ {N-1} years      → no penalty
    • JD requires {N} to {N+1} years → no penalty (perfect match)
    • JD requires {N+2} years        → cap final score at 7 (mild stretch)
    • JD requires {N+3} to {N+4}     → cap final score at 5 (significant gap)
    • JD requires {N+5}+ years       → cap final score at 3
    • JD requires {N+7}+ years (VP-tier) → cap final score at 2

    If JD doesn't state YOE explicitly: infer from title (Director ≈ 10+,
    Sr Director ≈ 12+, VP ≈ 15+) and apply the cap above.
  ```

- Make the rubric specific enough that Claude can distinguish a 9 from a 7 for this person's background

Get the project path first:
```bash
pwd
```

Then write the file using the Write tool. Do not use placeholder text — write the real profile.

---

## Step 4 — (No scraper edits needed)

Targets live in `candidate-profile.js` (which you wrote in Step 3). The
scrapers and skill files read from there at runtime — no code or markdown
edits required. Skip ahead.

If the user needs to refresh location filters for the `LOCATION_KEYWORDS`
substring matcher in `src/scrapers/greenhouse.js` and `lever.js`, that's
a generic match by city name (e.g., `'new york'`, `'remote'`) — defaults
work for any US-targeted user.

---

## Step 5 — Patch project path in skill files

Get the absolute project path:
```bash
pwd
```

In both `.claude/skill/SKILL.md` and `.claude/scheduled-task/SKILL.md`,
replace every occurrence of `<YOUR_PROJECT_PATH>` with the path from `pwd`.

LinkedIn URLs and company lists do NOT need patching — they're read
dynamically from `candidate-profile.js` at runtime.

---

## Step 6 — Create .env

```bash
ls .env 2>/dev/null && echo "exists" || cp .env.example .env && echo "created"
```

---

## Step 7 — Verify everything

Read `src/candidate-profile.js` to confirm it was written correctly. Show a brief excerpt (first ~20 lines) to the user so they can confirm it looks right.

```bash
head -30 src/candidate-profile.js
```

Also confirm the scraper updates:
```bash
grep "LOCATION_KEYWORDS" src/scrapers/greenhouse.js -A 3
```

---

## Step 8 — Completion summary

Report what was configured:

```
Setup complete ✓

Configured:
  ✓ src/candidate-profile.js — your personal scoring profile
  ✓ Location filters — [list cities]
  ✓ LinkedIn searches — [show first title example] OR ...
  ✓ Claude skill files — project path set to [path]
  ✓ .env created

What to do next:

  1. Install the /job-hunt skill
     Repackage .claude/skill/SKILL.md and double-click the .skill file.
     (See CLAUDE.md for the exact repackage command for your system.)

  2. Fill in any API keys you want in .env:
     • ANTHROPIC_API_KEY  — for standalone scoring (npm start)
                            Not needed when using /job-hunt in Claude Code
     • SERPAPI_KEY        — enables Google Jobs as a 4th source (optional)
     • SENDGRID_API_KEY   — enables email digests (optional)

  3. Run your first job search
     Type /job-hunt in Claude Code
     — or — npm run run-now (Greenhouse + Lever only, no LinkedIn)

To update your profile later (new job, new salary target, new titles):
  Edit src/candidate-profile.js directly — changes take effect on the next run.
```
