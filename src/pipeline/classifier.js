// ─── Heuristic email classifier (no LLM) ─────────────────────────────────────
// All classification uses regex patterns applied to subject, body, and sender.

// Known ATS domains — emails from these are very likely application-related
const ATS_DOMAINS = [
  'greenhouse.io', 'lever.co', 'workday.com', 'taleo.net', 'icims.com',
  'jobvite.com', 'smartrecruiters.com', 'ashbyhq.com', 'myworkday.com',
  'brassring.com', 'successfactors.com', 'ultipro.com', 'bamboohr.com',
  'recruiterbox.com', 'jazzhr.com', 'pinpointhq.com', 'dover.com',
  'rippling.com', 'gusto.com', 'workable.com', 'recruitee.com',
  'zohorecruit.com', 'hire.trakstar.com',
];

// Common free/consumer email providers — not company domains
const GENERIC_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'me.com', 'live.com', 'msn.com',
];

// ─── Pattern banks ────────────────────────────────────────────────────────────

const PATTERNS = {
  offer: [
    /offer\s+letter/i,
    /pleased\s+to\s+offer/i,
    /compensation\s+package/i,
    /extend\s+an\s+offer/i,
    /formal\s+offer/i,
    /we(?:'re|\s+are)\s+(?:excited|happy|pleased)\s+to\s+(?:extend|make|present)\s+(?:you\s+)?(?:an?\s+)?offer/i,
    /(?:verbal|written)\s+offer/i,
    /total\s+(?:compensation|comp)\s+package/i,
    /sign(?:ing)?\s+bonus/i,
    /start\s+date.*(?:offer|compensation)/i,
  ],

  rejection: [
    /decided\s+to\s+move\s+forward\s+with\s+other\s+candidates/i,
    /not\s+moving\s+forward/i,
    /will\s+not\s+be\s+moving\s+forward/i,
    /position\s+has\s+been\s+filled/i,
    /other\s+candidates\s+whose\s+experience/i,
    /not\s+selected/i,
    /unsuccessful/i,
    /regret\s+to\s+inform/i,
    /we(?:'ve|\s+have)\s+decided\s+to\s+(?:pursue|move\s+forward\s+with)\s+(?:other|different)/i,
    /not\s+a\s+(?:match|fit)\s+(?:at\s+this\s+time|currently|for\s+this)/i,
    /decided\s+not\s+to\s+(?:move|proceed)/i,
    /after\s+careful\s+consideration.*(?:not|unable)/i,
    /thank\s+you\s+for\s+(?:your\s+interest|applying|taking\s+the\s+time).*(?:not|regret|unfortunately)/i,
    /we\s+(?:regret|are\s+sorry)\s+to\s+inform/i,
    /position\s+(?:has\s+been|is\s+now)\s+(?:filled|closed)/i,
    /no\s+longer\s+(?:moving\s+forward|considering)/i,
  ],

  interview_scheduled: [
    /(?:schedule|confirm|book)\s+(?:a\s+)?(?:phone|video|virtual|in-person|onsite|on-site|technical|behavioral)\s+(?:screen|interview|call|chat)/i,
    /interview\s+(?:invitation|invite|request|confirmation|scheduled|confirmed)/i,
    /calendly\.com/i,
    /zoom\s+link/i,
    /phone\s+screen/i,
    /video\s+interview/i,
    /on.?site\s+interview/i,
    /technical\s+interview/i,
    /(?:we(?:'d|\s+would)\s+like\s+to|let's)\s+(?:schedule|set\s+up|arrange)\s+(?:a\s+)?(?:time|call|interview|meeting)/i,
    /(?:available|availability)\s+(?:for|to\s+(?:schedule|discuss))\s+(?:an?\s+)?interview/i,
    /hiring\s+manager\s+wants\s+to\s+(?:meet|chat|talk|connect)/i,
    /next\s+(?:round|step|stage).*interview/i,
    /(?:final|first|second|third)\s+(?:round|interview)/i,
  ],

  take_home_submitted: [
    /take[\s-]?home\s+(?:assignment|project|exercise|test|challenge)/i,
    /take[\s-]?home/i,
    /(?:coding|technical|work)\s+(?:challenge|sample|assessment|exercise)/i,
    /case\s+study\s+(?:assignment|submission|exercise)/i,
    /skills?\s+assessment/i,
    /complete\s+(?:a\s+)?(?:short\s+)?(?:assignment|project|exercise|assessment)/i,
    /submit\s+(?:your\s+)?(?:assignment|project|exercise|answers)/i,
    /submission\s+link/i,
  ],

  interview_follow_up: [
    /following\s+up\s+on\s+(?:your\s+)?(?:application|interview|our\s+(?:conversation|call))/i,
    /checking\s+in\s+(?:on|about|regarding)/i,
    /wanted\s+to\s+follow\s+up/i,
    /any\s+updates\s+(?:on|regarding|about)/i,
    /(?:where\s+(?:do\s+)?things?\s+stand|status\s+update)/i,
    /(?:haven't|have\s+not)\s+heard\s+back/i,
    /touch\s+base\s+(?:again|on)/i,
  ],

  application_viewed: [
    /your\s+application\s+was\s+viewed/i,
    /someone\s+viewed\s+your\s+application/i,
    /profile\s+was\s+viewed\s+by/i,
    /recruiter\s+viewed\s+your\s+profile/i,
    /your\s+(?:linkedin\s+)?profile\s+was\s+viewed/i,
    /employer\s+viewed\s+your/i,
  ],

  recruiter_outreach: [
    /i\s+came\s+across\s+your\s+(?:profile|background|resume|linkedin)/i,
    /i\s+noticed\s+your\s+(?:background|experience|profile)/i,
    /exciting\s+opportunity/i,
    /i(?:'d|\s+would)\s+love\s+to\s+connect/i,
    /(?:new\s+)?(?:job\s+)?opportunity(?:\s+that\s+might\s+interest\s+you)?/i,
    /we(?:'re|\s+are)\s+(?:currently\s+)?(?:looking|searching|hiring)\s+for/i,
    /i\s+think\s+you(?:'d|\s+would)\s+be\s+a\s+(?:great|good|perfect)\s+fit/i,
    /reaching\s+out\s+(?:because|regarding|about)/i,
    /thought\s+you\s+(?:might\s+be\s+interested|would\s+be\s+a\s+great)/i,
    /on\s+behalf\s+of\s+(?:my\s+)?(?:client|company|team)/i,
  ],

  application_submitted: [
    /thank\s+you\s+for\s+applying/i,
    /application\s+(?:received|submitted|confirmed)/i,
    /we\s+(?:have\s+)?received\s+your\s+application/i,
    /you(?:'ve|\s+have)\s+(?:applied|submitted\s+an?\s+application)\s+(?:to|for)/i,
    /your\s+application\s+(?:has\s+been\s+)?(?:successfully\s+)?(?:submitted|received)/i,
    /successfully\s+applied/i,
    /application\s+is\s+(?:under|being)\s+review/i,
    /we(?:'ll|\s+will)\s+review\s+your\s+application/i,
    /thank\s+you\s+for\s+your\s+interest\s+in\s+(?:the\s+)?(?:position|role|opportunity)/i,
    /thanks\s+for\s+applying/i,
  ],

  // Patterns for emails the candidate themselves sends — most often a post-interview
  // thank-you note. Detecting these lets us advance status to interview_follow_up
  // without needing a recruiter to reply first.
  sent_thank_you: [
    /thank\s+you\s+for\s+(?:taking\s+the\s+)?(?:your\s+)?time\s+(?:today|to\s+(?:speak|chat|meet|talk))/i,
    /thanks\s+(?:so\s+much\s+)?for\s+(?:taking\s+the\s+)?(?:your\s+)?time/i,
    /(?:it\s+was\s+)?(?:great|wonderful|a\s+pleasure)\s+(?:to\s+)?(?:speaking|chatting|meeting|talking|connect(?:ing)?)\s+with\s+you/i,
    /(?:really\s+)?enjoyed\s+(?:our\s+)?(?:conversation|chat|discussion|call|interview)/i,
    /following\s+up\s+(?:on|after)\s+(?:our|today's|yesterday's)\s+(?:conversation|chat|interview|call|meeting)/i,
    /appreciate(?:d)?\s+(?:the\s+)?(?:opportunity|chance)\s+to\s+(?:speak|chat|interview|connect|learn)/i,
    /thank\s+you\s+for\s+(?:the\s+)?(?:conversation|chat|interview|opportunity\s+to\s+(?:speak|interview|chat))/i,
    /looking\s+forward\s+to\s+(?:hearing|next\s+steps|the\s+next\s+(?:round|step))/i,
  ],
};

// ─── Company extraction ───────────────────────────────────────────────────────

function extractDomain(email) {
  const match = email?.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

function domainToCompanyName(domain) {
  if (!domain) return null;
  // Strip common suffixes
  const stripped = domain
    .replace(/\.(com|io|co|net|org|ai|app|careers|jobs|hr)(\.[a-z]{2})?$/, '')
    .replace(/^(mail|jobs|careers|recruiting|talent|hr|noreply|no-reply|donotreply|info|team)\./i, '');
  // Capitalize
  return stripped
    .split('.')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractCompany(subject, body, fromEmail) {
  const text = `${subject ?? ''} ${body ?? ''}`;

  // Explicit patterns in text
  const patterns = [
    /thank\s+you\s+for\s+(?:your\s+interest\s+in|applying\s+(?:to|at))\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50}?)(?:\.|,|\s+for|\s+\(|$)/,
    /(?:at|with|@)\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50}?)(?:\s+-|\s*\||,|\.|\s+for\s+the\s+role|$)/,
    /([A-Z][A-Za-z0-9\s&,.'-]{1,50}?)\s+[-–]\s+[A-Z]/,
    /applying\s+(?:for\s+)?(?:the\s+)?[A-Za-z\s]+(?:at|to|with)\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50?})(?:\.|,|$)/,
    /your\s+application\s+to\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50?})(?:\s+has|\s+is|\.|,|$)/i,
    /from\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50?})\s+recruiting/i,
    /the\s+([A-Z][A-Za-z0-9\s&,.'-]{1,50?})\s+team/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = match[1].trim().replace(/\s+/g, ' ');
      if (candidate.length > 1 && candidate.length < 60) return candidate;
    }
  }

  // Fall back to sender domain
  if (fromEmail) {
    const domain = extractDomain(fromEmail);
    if (domain && !GENERIC_EMAIL_DOMAINS.includes(domain)) {
      return domainToCompanyName(domain);
    }
  }

  return 'Unknown Company';
}

function extractRole(subject, body) {
  const text = `${subject ?? ''} ${body ?? ''}`;

  const patterns = [
    /(?:position|role|job)\s+(?:of|for|titled?)\s+[""']?([A-Za-z\s,&\/\-–()]+?)[""']?(?:\s+at|\s+with|\s*,|\s*\.|\s*\(|$)/i,
    /applying\s+for\s+(?:the\s+)?[""']?([A-Za-z\s,&\/\-–()]+?)[""']?(?:\s+(?:position|role|job|opportunity))?(?:\s+at|\s*,|\s*\.|$)/i,
    /application\s+for\s+[""']?([A-Za-z\s,&\/\-–()]+?)[""']?(?:\s+at|\s*,|\s*\.|$)/i,
    /([A-Za-z\s,&\/\-–()]{3,60}?)\s+[-–@|]\s+[A-Z][A-Za-z0-9\s&,.'-]+/,
    /^(?:re:\s+)?([A-Za-z\s,&\/\-–()]{3,60}?)\s+(?:at|with|@)\s+/i,
    /interview.*(?:for|regarding)\s+(?:the\s+)?([A-Za-z\s,&\/\-–()]{3,60?})\s+(?:position|role)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = match[1].trim().replace(/\s+/g, ' ');
      // Basic sanity checks
      if (
        candidate.length > 2 &&
        candidate.length < 80 &&
        !/^(re|fwd|hello|hi|dear|thank|we|i|you|your|our|the)$/i.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

// ─── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify an email into a job application event type.
 *
 * @param {object} params
 * @param {string} params.subject
 * @param {string} params.from
 * @param {string} params.body
 * @param {string} params.snippet
 * @param {string} [params.to]
 * @param {string} [params.userEmail]
 * @returns {{ eventType: string, company: string, role: string|null, confidence: number }}
 */
export function classifyEmail({ subject, from, body, snippet, to, userEmail }) {
  const subjectLower = (subject ?? '').toLowerCase();
  const bodyText = (body ?? '') + ' ' + (snippet ?? '');
  const combined = `${subjectLower} ${bodyText.toLowerCase()}`;
  const fromDomain = extractDomain(from);
  const isAts = ATS_DOMAINS.some(d => fromDomain?.includes(d));
  const isNoReply = /noreply|no-reply|donotreply|do-not-reply/i.test(from ?? '');

  // Detect outbound emails (sent BY the user). When userEmail is provided, match it
  // exactly; otherwise fall back to checking common consumer email domains in the From.
  const fromAddr = extractDomain(from)
    ? from.toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0]
    : null;
  const isSentByUser = userEmail
    ? fromAddr === userEmail.toLowerCase()
    : !!(fromDomain && GENERIC_EMAIL_DOMAINS.includes(fromDomain) && to && !to.toLowerCase().includes(fromAddr ?? '@'));

  // Helper: test a list of patterns against text
  const matches = (patternList, text) => patternList.some(p => p.test(text));

  let eventType = 'unknown';
  let confidence = 0.3;

  // OUTBOUND CLASSIFICATION: if the user sent this email, the only thing we care
  // about is whether it's a post-interview thank-you note. Treat that as a strong
  // signal to advance status to interview_follow_up.
  if (isSentByUser) {
    if (matches(PATTERNS.sent_thank_you, combined)) {
      eventType = 'interview_follow_up';
      confidence = 0.85;
    } else {
      // Sent email that isn't a thank-you — skip it (don't pollute classification)
      eventType = 'unknown';
      confidence = 0.2;
    }
  } else {
    // INBOUND CLASSIFICATION: existing priority order
    // offer > rejection > interview_scheduled > interview_follow_up
    //   > application_viewed > recruiter_outreach > application_submitted

    if (matches(PATTERNS.offer, combined)) {
      eventType = 'offer';
      confidence = 0.95;
    } else if (matches(PATTERNS.rejection, combined)) {
      eventType = 'rejection';
      confidence = 0.9;
    } else if (matches(PATTERNS.take_home_submitted, combined)) {
      eventType = 'take_home_submitted';
      confidence = /take.?home/i.test(subject ?? '') ? 0.92 : 0.75;
    } else if (matches(PATTERNS.interview_scheduled, combined)) {
      eventType = 'interview_scheduled';
      confidence = /interview/i.test(subject ?? '') ? 0.92 : 0.75;
    } else if (matches(PATTERNS.interview_follow_up, combined)) {
      eventType = 'interview_follow_up';
      confidence = 0.7;
    } else if (matches(PATTERNS.application_viewed, combined)) {
      eventType = 'application_viewed';
      confidence = 0.85;
    } else if (
      !isNoReply &&
      !isAts &&
      matches(PATTERNS.recruiter_outreach, combined)
    ) {
      eventType = 'recruiter_outreach';
      confidence = 0.75;
    } else if (
      matches(PATTERNS.application_submitted, combined) ||
      (isAts && isNoReply)
    ) {
      eventType = 'application_submitted';
      confidence = isAts ? 0.88 : 0.72;
    } else if (isAts) {
      eventType = 'application_submitted';
      confidence = 0.5;
    }
  }

  // Company extraction:
  // - Outbound: prefer the recipient's domain directly (text patterns are unreliable
  //   in user-authored prose like "Thank you - Acme interview")
  // - Inbound: try explicit text patterns first, fall back to sender's domain
  let company;
  if (isSentByUser) {
    const toDomain = extractDomain(to);
    if (toDomain && !GENERIC_EMAIL_DOMAINS.includes(toDomain)) {
      company = domainToCompanyName(toDomain);
    } else {
      // Recipient is a generic-domain personal email — try text patterns as fallback
      company = extractCompany(subject, bodyText, to);
    }
  } else {
    company = extractCompany(subject, bodyText, from);
  }
  const role = extractRole(subject, bodyText);

  return { eventType, company, role, confidence };
}

/**
 * Map an eventType to an application current_status value.
 */
export function eventTypeToStatus(eventType) {
  const map = {
    application_submitted: 'applied',
    application_viewed: 'application_viewed',
    recruiter_outreach: 'recruiter_outreach',
    interview_scheduled: 'interview_scheduled',
    take_home_submitted: 'take_home_submitted',
    interview_follow_up: 'interview_follow_up',
    offer: 'offer',
    rejection: 'rejection',
    unknown: 'applied',
  };
  return map[eventType] ?? 'applied';
}
