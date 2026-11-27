/**
 * Sign-in classifiers shared by the Gemini runner (sign-in card) and the downstream failure class (runner-settings.ts),
 * so the two never disagree (reliability plan Rev 3, gate 1).
 *
 * Whether Gemini's (agy's) own last words mean "sign in with Google". Only whole login phrases count — "not authenticated",
 * "please sign in", "login required", "agy acp --login" … — so startup, logging ("logging", "log in to file"), sandbox
 * and loopback failures that merely contain those letters are reported as themselves, not as a sign-in card.
 * Three look-alikes are excluded too:
 *  - proxy authentication (HTTP 407, "Proxy Authentication Required", "Proxy returned 407", proxy credentials,
 *    "Authentication failed for proxy server") is the network's sign-in, not Google's;
 *  - an account mismatch ("Wrong Google account: please log in with …", "Account mismatch: not authenticated as …") means
 *    the owner IS signed in, to the wrong account: signing in again with the same card would not fix it, so a mismatch
 *    anywhere in the message means no sign-in at all, even when another clause names a Google sign-in;
 *  - a bare `--login` only counts as agy's own hint (`agy acp --login`), never a CLI/shell flag error ("unknown option
 *    '--login'", "bash --login: …") or a path ("/tmp/--login").
 * Clauses about any of them are dropped before matching, and once a proxy-auth clause is present only Google-specific
 * wording still counts.
 */
const GOOGLE_SIGN_IN = [
  /\b(?:not|un)[\s-]?authenticated\b/i,
  /\bauthentication (?:is )?(?:required|needed|failed|expired)\b/i,
  /\b(?:please|must|need to|needs you to|required to)\s+(?:re-?)?(?:sign|log)[\s-]?in\b/i,
  /\b(?:sign|log)[\s-]?in (?:is )?(?:required|needed|expired)\b/i,
  /\bnot (?:signed|logged)[\s-]?in\b/i,
];
/** Wording that can only mean Google / agy's own sign-in or OAuth — still trusted when a proxy failure is also present. */
const GOOGLE_SPECIFIC_SIGN_IN = [
  /\bGoogleSignInRequired\b/,
  /\b(?:sign|log)[\s-]?in with (?:your )?(?:personal )?google\b/i,
  /\bagy(?:\s+acp)?\s+--login\b/i,
  /\bgoogle\b[^\n]{0,40}\b(?:oauth|credentials?|token|account|sign[\s-]?in|log[\s-]?in)\b[^\n]{0,30}\b(?:expired|invalid|revoked|missing|required)\b/i,
  /\b(?:oauth|google)\b[^\n]{0,20}\b(?:access|refresh|id)?[\s-]?token\b[^\n]{0,10}\b(?:has\s+)?(?:expired|been revoked|is invalid|invalid|missing)\b/i,
  /\binvalid_grant\b/i,
  // agy 1.5.x: "You're signed in to Gemini Enterprise, but couldn't load the saved credentials."
  /\bsigned[\s-]?in to Gemini(?: Enterprise)?\b[^\n]{0,40}\bcould(?:n['’]?t| ?not) load (?:the |your )?saved credentials\b/i,
  /\bcould(?:n['’]?t| ?not) load (?:the |your )?saved (?:google |gemini )?credentials\b/i,
];
/** HTTP 407 / proxy authentication: the network proxy wants credentials, Google sign-in would not help. */
const PROXY_AUTH = /\b(?:auth(?:entication|orization)?|(?:un|not\s)authenticated|credentials?)\b[^\n]{0,40}?\b(?:for|by|from|at|to|with|on|against)\s+(?:the\s+|an?\s+|your\s+)?(?:[\w.:\/-]+\s+){0,2}?proxy\b|\bproxy[\s-]+(?:auth\w*|credentials?|log[\s-]?in|sign[\s-]?in)\b|\bproxy\b[^\n]{0,60}\b(?:(?:un|not\s)authenticated|auth(?:entication|orization)? (?:is )?(?:required|failed|needed))\b|\bproxy\b[^\n]{0,40}\b407\b|\b(?:HTTP(?:\/[\d.]+)?|status(?:[\s_-]?code)?|code|error)\s*[:=]?\s*407\b|\b407\s+proxy\b|\bCONNECT\s+tunnel\s+failed\b[^\n]{0,40}\b407\b|\bproxy\s+response\s*\(?\s*407\b|\b(?:HTTPS?|ALL)_PROXY\b[^\n]{0,120}\b(?:returned|response|responded|status)\b[^\n]{0,20}\(?\s*407\b/i;
/** Signed in, but to the wrong account: a sign-in card asking to sign in again would loop. */
const ACCOUNT_MISMATCH = /\bwrong\s+(?:google\s+|gemini\s+)?account\b|\baccount\s+mismatch\b|\bmismatched\s+account\b|\b(?:different|another)\s+(?:google\s+)?account\s+than\b|\b(?:signed|logged)[\s-]?in\s+as\b[^\n]{0,80}\b(?:instead|expected|but)\b/i;
/** A CLI or shell rejecting a `--login` flag, or a login shell (`bash --login`), is not agy asking for Google sign-in. */
const LOGIN_FLAG_ERROR = /\b(?:unknown|unrecognized|unrecognised|invalid|unsupported|illegal|unexpected|bad)\s+(?:command[\s-]line\s+)?(?:option|flag|argument|switch|parameter)s?\b[^\n]*--?login\b|--?login['"`]?:?\s+(?:is\s+)?(?:an?\s+)?(?:unknown|unrecognized|unrecognised|invalid|unsupported|not (?:a\s+)?(?:supported|recognized|recognised|defined|valid))\b|\bflag provided but not defined:\s*-?-login\b|\b(?:ba|z|k|da|fi|c|tc)?sh\s+(?:-\w+\s+)*--login\b/i;
/** Other providers' own sign-in wording (Claude Code, Codex), for the downstream class only — never a Google sign-in card. */
const PROVIDER_SIGN_IN = [
  /\b(?:sign|log)[\s-]?in to (?:claude|codex|chatgpt|gemini|antigravity|your (?:claude|chatgpt|google) account)\b/i,
  /\b(?:sign|log)[\s-]?in with (?:chatgpt|claude|your (?:claude|chatgpt) (?:subscription|account))\b/i,
  /\b(?:codex|claude(?:\s+auth)?)\s+login\b/i,
  /\b(?:token|session|subscription|credentials?)\s+(?:has\s+)?expired\b|\bexpired\s+(?:token|session|subscription|credentials?)\b/i,
];
/**
 * A bare "Unauthorized" / 401 is the provider's own sign-in only when nothing on the same line pins it on someone else:
 * a tool or third-party API ("GitHub API 401 Unauthorized", an MCP server, a webhook, a non-provider URL) failing auth
 * does not mean the provider needs a sign-in.
 */
const UNAUTHORIZED = /\bunauthori[sz]ed\b/i;
const THIRD_PARTY_AUTH = [
  // Tools, plugins and MCP servers are the agent's own downstream calls.
  /\b(?:mcp|tool|plugin|webhook|connector)\b/i,
  // Well-known third-party services.
  /\b(?:github|gitlab|bitbucket|slack|jira|atlassian|notion|linear|vercel|netlify|npm|docker|stripe|twilio|sentry|figma|discord|dropbox|aws|azure|heroku|cloudflare|supabase|firebase)\b/i,
  // A named service's API/server ("Acme API", "Jenkins server"): a capitalised name that is not a provider or a plain word.
  /(?<!\b(?:Claude|Anthropic|OpenAI|Google|Gemini)\s)\b(?!(?:Claude|Anthropic|OpenAI|Codex|ChatGPT|Gemini|Google|Antigravity|Agy|Code|Invalid|Missing|Expired|Bad|Wrong|Unauthori[sz]ed|Error|Failed|The|This|An?|Your|Its|HTTP|Request)\b)[A-Z][\w.-]*\s+(?:REST\s+|GraphQL\s+)?(?:API|[Ss]erver|[Ee]ndpoint|[Ww]ebhook)\b/,
  // A URL on a host that is not the provider's.
  /\bhttps?:\/\/(?![\w.-]*\b(?:anthropic\.com|claude\.ai|openai\.com|chatgpt\.com|googleapis\.com|google\.com)\b)[\w.-]+/i,
];
const isProviderUnauthorized = (relevant: string) =>
  relevant.split('\n').some(line => UNAUTHORIZED.test(line) && !THIRD_PARTY_AUTH.some(pattern => pattern.test(line)));

function clausesOf(diagnostic: string) {
  // Scoped to whole clauses: only a clause that is itself a proxy-auth / account-mismatch failure counts, so a harmless
  // "Connecting via proxy …" line never suppresses a later sign-in error.
  const clauses = diagnostic.split(/\r?\n|;\s*|\.\s+/);
  const mismatch = clauses.some(clause => ACCOUNT_MISMATCH.test(clause));
  const guarded = mismatch || clauses.some(clause => PROXY_AUTH.test(clause));
  const relevant = clauses
    .filter(clause => !PROXY_AUTH.test(clause) && !ACCOUNT_MISMATCH.test(clause) && !LOGIN_FLAG_ERROR.test(clause))
    .join('\n');
  return { mismatch, guarded, relevant };
}

export const isGoogleSignInFailure = (diagnostic: string) => {
  const { mismatch, guarded, relevant } = clausesOf(diagnostic);
  // Rev 3: an account mismatch never shows a sign-in card, whatever another clause says ("Wrong account. Sign in with
  // your Google account a@b" is still the wrong account).
  if (mismatch) return false;
  if (GOOGLE_SPECIFIC_SIGN_IN.some(pattern => pattern.test(relevant))) return true;
  return !guarded && GOOGLE_SIGN_IN.some(pattern => pattern.test(relevant));
};

/** Any provider's request failed because it needs a sign-in (Google, Claude Code, Codex), with the same exclusions. */
export const isSignInFailure = (diagnostic: string) => {
  if (isGoogleSignInFailure(diagnostic)) return true;
  const { guarded, relevant } = clausesOf(diagnostic);
  return !guarded && (PROVIDER_SIGN_IN.some(pattern => pattern.test(relevant)) || isProviderUnauthorized(relevant));
};
