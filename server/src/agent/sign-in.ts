/**
 * Sign-in classifiers shared by the Gemini runner (sign-in card) and the downstream failure class (runner-settings.ts),
 * so the two never disagree (reliability plan Rev 3, gate 1).
 *
 * Whether Gemini's (agy's) own last words mean "sign in with Google". Only whole login phrases count — "not authenticated",
 * "please sign in", "login required", "agy acp --login" … — so startup, logging ("logging", "log in to file"), sandbox
 * and loopback failures that merely contain those letters are reported as themselves, not as a sign-in card.
 * Three look-alikes are excluded too:
 *  - proxy authentication (HTTP 407, "Proxy Authentication Required", "Proxy returned 407", proxy credentials) is the
 *    network's sign-in, not Google's;
 *  - an account mismatch ("Wrong Google account: please log in with …", "Account mismatch: not authenticated as …") means
 *    the owner IS signed in, to the wrong account: signing in again with the same card would not fix it;
 *  - a bare `--login` only counts as agy's own hint (`agy acp --login`), never a CLI/shell flag error ("unknown option
 *    '--login'", "bash --login: …") or a path ("/tmp/--login").
 * Clauses about any of them are dropped before matching, and once a proxy-auth or account-mismatch clause is present only
 * Google-specific wording still counts.
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
const PROXY_AUTH = /\bproxy[\s-]+(?:auth\w*|credentials?|log[\s-]?in|sign[\s-]?in)\b|\bproxy\b[^\n]{0,60}\b(?:(?:un|not\s)authenticated|auth(?:entication|orization)? (?:is )?(?:required|failed|needed))\b|\bproxy\b[^\n]{0,40}\b407\b|\b(?:HTTP(?:\/[\d.]+)?|status(?:[\s_-]?code)?|code|error)\s*[:=]?\s*407\b|\b407\s+proxy\b|\bCONNECT\s+tunnel\s+failed\b[^\n]{0,40}\b407\b|\bproxy\s+response\s*\(?\s*407\b|\b(?:HTTPS?|ALL)_PROXY\b[^\n]{0,120}\b(?:returned|response|responded|status)\b[^\n]{0,20}\(?\s*407\b/i;
/** Signed in, but to the wrong account: a sign-in card asking to sign in again would loop. */
const ACCOUNT_MISMATCH = /\bwrong\s+(?:google\s+|gemini\s+)?account\b|\baccount\s+mismatch\b|\bmismatched\s+account\b|\b(?:different|another)\s+(?:google\s+)?account\s+than\b|\b(?:signed|logged)[\s-]?in\s+as\b[^\n]{0,80}\b(?:instead|expected|but)\b/i;
/** A CLI or shell rejecting a `--login` flag, or a login shell (`bash --login`), is not agy asking for Google sign-in. */
const LOGIN_FLAG_ERROR = /\b(?:unknown|unrecognized|unrecognised|invalid|unsupported|illegal|unexpected|bad)\s+(?:command[\s-]line\s+)?(?:option|flag|argument|switch|parameter)s?\b[^\n]*--?login\b|--?login['"`]?:?\s+(?:is\s+)?(?:an?\s+)?(?:unknown|unrecognized|unrecognised|invalid|unsupported|not (?:a\s+)?(?:supported|recognized|recognised|defined|valid))\b|\bflag provided but not defined:\s*-?-login\b|\b(?:ba|z|k|da|fi|c|tc)?sh\s+(?:-\w+\s+)*--login\b/i;
/** Other providers' own sign-in wording (Claude Code, Codex), for the downstream class only — never a Google sign-in card. */
const PROVIDER_SIGN_IN = [
  /\b(?:sign|log)[\s-]?in to (?:claude|codex|chatgpt|gemini|antigravity|your (?:claude|chatgpt|google) account)\b/i,
  /\b(?:sign|log)[\s-]?in with (?:chatgpt|claude|your (?:claude|chatgpt) (?:subscription|account))\b/i,
  /\b(?:codex|claude(?:\s+auth)?)\s+login\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b(?:token|session|subscription|credentials?)\s+(?:has\s+)?expired\b|\bexpired\s+(?:token|session|subscription|credentials?)\b/i,
];

function clausesOf(diagnostic: string) {
  // Scoped to whole clauses: only a clause that is itself a proxy-auth / account-mismatch failure counts, so a harmless
  // "Connecting via proxy …" line never suppresses a later sign-in error.
  const clauses = diagnostic.split(/\r?\n|;\s*|\.\s+/);
  const guarded = clauses.some(clause => PROXY_AUTH.test(clause) || ACCOUNT_MISMATCH.test(clause));
  const relevant = clauses
    .filter(clause => !PROXY_AUTH.test(clause) && !ACCOUNT_MISMATCH.test(clause) && !LOGIN_FLAG_ERROR.test(clause))
    .join('\n');
  return { guarded, relevant };
}

export const isGoogleSignInFailure = (diagnostic: string) => {
  const { guarded, relevant } = clausesOf(diagnostic);
  if (GOOGLE_SPECIFIC_SIGN_IN.some(pattern => pattern.test(relevant))) return true;
  return !guarded && GOOGLE_SIGN_IN.some(pattern => pattern.test(relevant));
};

/** Any provider's request failed because it needs a sign-in (Google, Claude Code, Codex), with the same exclusions. */
export const isSignInFailure = (diagnostic: string) => {
  if (isGoogleSignInFailure(diagnostic)) return true;
  const { guarded, relevant } = clausesOf(diagnostic);
  return !guarded && PROVIDER_SIGN_IN.some(pattern => pattern.test(relevant));
};
