import { UsageHandoffCard } from '../HandoffControls';
import { useEffect, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import type { CardBody, Row } from '@shared/types';
import { api, openPopup } from '../../lib/api';
import { featuresApi } from '../../lib/featuresApi';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { WorkCard } from './WorkCard';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const prettyTool = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const KNOWN: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', clickup: 'ClickUp', googledocs: 'Google Docs', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googletasks: 'Google Tasks', googlemeet: 'Google Meet' };
/** "googlecalendar" → "Google Calendar", "slack" → "Slack". */
export const humanizeToolkit = (slug: string) => KNOWN[slug.toLowerCase()] ?? slug.replace(/^(google|microsoft)(?=\w)/i, '$1 ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: 'Allowed once', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };

export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const decide = (d: 'allow' | 'always' | 'deny') => run(d, () => api.approve(body.approvalId, d));
  const name = body.toolkit ? humanizeToolkit(body.toolkit) : prettyTool(body.tool);
  return (
    <div className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={name} logo={body.toolkit ? `https://logos.composio.dev/api/${body.toolkit.toLowerCase()}` : undefined} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{name}</div>
        </div>
      </div>
      {body.detail && <div className="card__body">{body.detail}</div>}
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>Don't allow</button>
            {!['ask_grok', 'ask_subscription', 'github_create_repo', 'start_cloud_session'].includes(body.tool) && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')}>Always allow</button>}
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('allow')}>Allow</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {APPROVAL_OUTCOME[body.status] ?? body.status}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return (
    <div className={`card question-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__q">{body.question}</div>
        <div className="question-card__hint">{pending ? 'Pick an option or reply in your own words' : body.status === 'dismissed' ? 'Skipped' : 'Answered'}</div>
      </div>
      <div className="question-card__options">
        {body.options.map((opt, i) => {
          const chosen = body.answer === opt;
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              onClick={() => run(String(i), () => api.answer(row.botId, row.seq, opt))}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{opt}</span>
              {chosen && <Icon name="check" size={12} opacity={0.6} style={{ marginLeft: 'auto', marginTop: 6 }} />}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="question-card__foot">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row.seq))}>Skip</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- connect ----------------

export function ConnectCard({ row, body }: { row: Row; body: Card<'connect'> }) {
  const { busy, error, run } = useBusy();
  const [waiting, setWaiting] = useState(false);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const pending = body.status === 'pending';

  // Leave the "waiting" state once the server reports a connection change or the card resolves.
  useEffect(() => { setWaiting(false); }, [connectionsVersion, body.status]);

  const connect = () => run('connect', async () => {
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect(body.toolkit, row.botId, row.seq);
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setWaiting(true);
    } catch (e) { popup?.close(); throw e; }
  });

  return (
    <div className={`card connect-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={body.toolkitName} logo={body.logo} size={44} />
        <div className="card__titles">
          <div className="card__title">Connect {body.toolkitName}</div>
          <div className="card__sub">{body.reason}</div>
        </div>
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(row.botId, row.seq))}>Skip</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={connect}>{waiting ? 'Waiting for sign-in…' : 'Connect'}</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'connected' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'connected' ? `${body.toolkitName} connected` : 'Skipped'}
        </div>
      )}
    </div>
  );
}

// ---------------- Claude Cloud (strict: GitHub only, fixes approved right here) ----------------

const CLOUD_OUTCOME: Record<string, string> = { started: 'Cloud work started', cancelled: 'Cancelled', allowed: 'Allowed', denied: 'Not allowed', expired: 'Expired' };
/** Outcome of the dedicated folder-trust card (Trust folder / Cancel). */
const TRUST_OUTCOME: Record<string, string> = { allowed: 'Folder trusted', denied: 'Cancelled: folder not trusted', expired: 'Expired' };

export function CloudCard({ row, body }: { row: Row; body: Card<'cloud'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const working = body.status === 'working';
  const pick = (id: string) => run(id, () => featuresApi.cloudCardAction(row.botId, row.seq, id));
  const permission = body.mode === 'permission';
  const trust = permission && body.blocker === 'folder-trust';
  const outcome = (trust ? TRUST_OUTCOME[body.status] : undefined) ?? CLOUD_OUTCOME[body.status] ?? body.status;
  return (
    <div className={`card approval-card cloud-card${pending || working ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name="GitHub" logo="https://logos.composio.dev/api/github" size={44} />
        <div className="card__titles">
          <div className="card__title">{trust ? 'Trust this folder for Claude Cloud?' : permission ? 'Allow Claude Cloud?' : body.status === 'started' ? `Claude Cloud on ${body.repo}` : 'Claude Cloud needs one step'}</div>
          <div className="card__sub">{body.title || body.query || 'Cloud work'}</div>
        </div>
      </div>
      <div className="card__body">
        {body.problem}
        {body.solution && <><br /><br />{permission && !trust ? <code>{body.solution}</code> : <span style={{ whiteSpace: 'pre-line' }}>{body.solution}</span>}</>}
      </div>
      {body.device && working && (
        <div className="card__body" role="status">
          One-time GitHub code: <strong style={{ userSelect: 'all' }}>{body.device.code}</strong>{' '}
          <button type="button" className="link-btn" onClick={() => { void copyText(body.device!.code); openPopup(body.device!.url); }}>Copy code and open GitHub</button>
        </div>
      )}
      {body.note && <div className="card__body" role="status">{body.note}</div>}
      {pending ? (
        <div className="question-card__options">
          {body.options.map(option => option.kind === 'open'
            ? <a key={option.id} className="question-option" href={option.url} target="_blank" rel="noreferrer">
                <span className="question-option__label">{option.label} ↗{option.hint ? <><br /><small>{option.hint}</small></> : null}</span></a>
            : <button key={option.id} type="button" className="question-option" disabled={!!busy} onClick={() => pick(option.id)}>
                <span className="question-option__label">{busy === option.id ? 'Working…' : option.label}{option.hint ? <><br /><small>{option.hint}</small></> : null}</span>
              </button>)}
        </div>
      ) : working ? null : (
        <div className={`card__outcome is-${body.status === 'started' || body.status === 'allowed' ? 'allowed' : 'denied'}`}>
          <Icon name={body.status === 'started' || body.status === 'allowed' ? 'check' : 'close'} size={12} opacity={0.7} />
          {outcome}
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- draft (screen 02) ----------------

const CHANNEL_LABEL: Record<string, string> = { email: 'Email', slack: 'Slack', message: 'Chat' };

export function DraftCard({ body }: { body: Card<'draft'> }) {
  const { busy, error, run } = useBusy();
  const user = useStore((s) => s.user);
  const pending = body.status === 'pending';
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await copyText(body.text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } };
  const handle = user?.email ? `@${user.email.split('@')[0]}` : '';
  return (
    <div className={`card draft-card${pending ? '' : ' is-resolved'}`}>
      <div className="draft-card__head">
        <span className="draft-card__tile"><Icon name="chat_filled" size={18} color="#FFFFFF" /></span>
        <div className="draft-card__titles">
          <div className="draft-card__channel">{CHANNEL_LABEL[body.channel] ?? 'Message'}</div>
          <div className="draft-card__from">{handle}</div>
        </div>
        <button type="button" className="draft-card__copy" onClick={copy} aria-label="Copy draft" title={copied ? 'Copied' : 'Copy'}>
          <Icon name={copied ? 'check' : 'copy'} size={12} opacity={0.66} />
        </button>
      </div>
      <div className="draft-card__content">
        <div className="draft-card__to">
          <span className="draft-card__to-label">To</span>
          <span className="draft-card__to-avatar">{(body.to.trim()[0] ?? '?').toUpperCase()}</span>
          <span className="draft-card__to-name">{body.to}</span>
        </div>
        {body.subject && <div className="draft-card__subject">{body.subject}</div>}
        <div className="draft-card__text">{body.text}</div>
      </div>
      {pending ? (
        <div className="draft-card__actions">
          <button type="button" className="btn btn--secondary btn--grow" disabled={!!busy} onClick={() => run('discard', () => api.approve(body.approvalId, 'deny'))}>Discard</button>
          <button type="button" className="btn btn--primary btn--grow" disabled={!!busy} onClick={() => run('send', () => api.approve(body.approvalId, 'allow'))}>Send</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`} style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'sent' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'sent' ? 'Sent' : 'Discarded'}
        </div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{error}</div>}
    </div>
  );
}

// ---------------- provider sign-in (Gemini → Google) ----------------

export function SignInCard({ row, body }: { row: Row; body: Card<'sign-in'> }) {
  const { busy, error, run } = useBusy();
  const open = body.status === 'pending' || body.status === 'working';
  const act = (action: 'open' | 'check' | 'dismiss') => run(action, () => featuresApi.signInCardAction(row.botId, row.seq, action));
  return (
    <div className={`card approval-card sign-in-card${open ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name="Google" logo="https://logos.composio.dev/api/google" size={44} />
        <div className="card__titles">
          <div className="card__title">Sign in to {body.providerName}</div>
          <div className="card__sub">Gemini needs a Google sign-in</div>
        </div>
      </div>
      <div className="card__body">
        {body.reason}
        <br /><br />
        Or run <code>{body.command}</code> in Terminal.
        {body.note && <><br /><br />{body.note}</>}
      </div>
      {open ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => act('dismiss')}>Dismiss</button>
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void copyText(body.command)}>Copy command</button>
          {/* Once the sign-in was opened, "I've signed in" stays the main button, also after a failed check (retry it
              directly); opening the sign-in again is still there for a closed Terminal window. */}
          {body.status === 'working' && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => act('open')}>{busy === 'open' ? 'Opening…' : 'Open sign-in again'}</button>}
          {body.status === 'working'
            ? <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => act('check')}>{busy === 'check' ? 'Checking…' : "I've signed in"}</button>
            : <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => act('open')}>{busy === 'open' ? 'Opening…' : 'Sign in with Google'}</button>}
        </div>
      ) : (
        <div className={`card__outcome is-${body.status === 'signed-in' ? 'allowed' : 'denied'}`}>
          <Icon name={body.status === 'signed-in' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'signed-in' ? 'Signed in' : 'Dismissed'}
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'connect': return <ConnectCard row={row} body={b} />;
    case 'draft': return <DraftCard body={b} />;
    case 'handoff': return <UsageHandoffCard row={row} body={b} />;
    case 'work': return <WorkCard body={b} botId={row.botId} />;
    case 'cloud': return <CloudCard row={row} body={b} />;
    case 'sign-in': return <SignInCard row={row} body={b} />;
    default: return null;
  }
}
