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

**SCORING_RUBRIC guidelines:**

- Reference the user's actual target titles in the 9–10 band (not generic placeholders)
- Reference their actual ideal company types in the descriptions
- Reference their actual salary floor in SALARY GUIDANCE
- Make the rubric specific enough that Claude can distinguish a 9 from a 7 for this person's background

Get the project path first:
```bash
pwd
```

Then write the file using the Write tool. Do not use placeholder text — write the real profile.

---

## Step 4 — Update location filters in scrapers

Based on the cities from Step 2c, update the `LOCATION_KEYWORDS` array in both scraper files.

**City → keyword mapping:**

| City | Keywords to include |
|---|---|
| New York | `'new york'`, `'ny'`, `'nyc'` |
| San Francisco | `'san francisco'`, `'bay area'` |
| Los Angeles | `'los angeles'`, `'la'` |
| Chicago | `'chicago'`, `'il'` |
| Austin | `'austin'`, `'tx'` |
| Seattle | `'seattle'`, `'wa'` |
| Boston | `'boston'`, `'ma'` |
| Miami | `'miami'`, `'fl'` |
| Denver | `'denver'`, `'co'` |
| Atlanta | `'atlanta'`, `'ga'` |
| Remote | always add `'remote'` if user included Remote |

Collect all keywords from the user's cities, always include `'remote'`, then use the Edit tool to replace the `LOCATION_KEYWORDS` array in both files:

**`src/scrapers/greenhouse.js`** — find and replace the `LOCATION_KEYWORDS` array.

**`src/scrapers/lever.js`** — same replacement.

Also update `LOCATIONS` in **`src/scrapers/serpapi.js`**:

| City | SerpAPI location string |
|---|---|
| New York | `'New York, NY'` |
| San Francisco | `'San Francisco Bay Area, CA'` |
| Los Angeles | `'Los Angeles, CA'` |
| Chicago | `'Chicago, IL'` |
| Austin | `'Austin, TX'` |
| Seattle | `'Seattle, WA'` |
| Boston | `'Boston, MA'` |
| Miami | `'Miami, FL'` |
| Denver | `'Denver, CO'` |
| Atlanta | `'Atlanta, GA'` |

---

## Step 5 — Patch the Claude skill files

Get the absolute project path:
```bash
pwd
```

Then update both skill files:

**Files to update:**
- `.claude/skill/SKILL.md`
- `.claude/scheduled-task/SKILL.md`

**Changes to make in each file:**

1. **Replace `<YOUR_PROJECT_PATH>`** — replace every occurrence with the absolute path from `pwd`.

2. **Replace LinkedIn search URLs** — build new URLs from the user's titles (Step 2b) and cities (Step 2c).

   URL format:
   ```
   https://www.linkedin.com/jobs/search/?keywords=KEYWORDS&location=LOCATION&f_TPR=r604800
   ```

   Keywords: take the user's target titles (up to 6), wrap each in double quotes, join with `+OR+`, URL-encode spaces as `+`.
   Example: `"Head+of+Growth"+OR+"Director+of+Growth"+OR+"VP+Growth"`

   LinkedIn location strings by city:
   | City | LinkedIn location parameter |
   |---|---|
   | New York | `New+York%2C+United+States` |
   | San Francisco | `San+Francisco+Bay+Area` |
   | Los Angeles | `Los+Angeles+Metropolitan+Area` |
   | Chicago | `Chicago%2C+Illinois%2C+United+States` |
   | Austin | `Austin%2C+Texas%2C+United+States` |
   | Seattle | `Seattle%2C+Washington%2C+United+States` |
   | Boston | `Boston%2C+Massachusetts%2C+United+States` |
   | Miami | `Miami%2C+Florida%2C+United+States` |
   | Denver | `Denver%2C+Colorado%2C+United+States` |
   | Atlanta | `Atlanta%2C+Georgia%2C+United+States` |

   Generate one URL per city (up to 3). Update the section headers (### 2a, ### 2b, ### 2c) to match the user's cities.

Use the Edit tool to make these replacements in both skill files.

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
