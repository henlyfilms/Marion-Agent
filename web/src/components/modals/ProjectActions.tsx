import { useState, type FormEvent, type ReactNode } from 'react';
import { featuresApi } from '../../lib/featuresApi';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from './Modal';

function ProjectModal({ title, onClose, children, onSubmit, busy }: {
  title: string; onClose: () => void; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean;
}) {
  return (
    <Modal label={title} onClose={() => { if (!busy) onClose(); }} className="utility-modal">
      <form onSubmit={onSubmit}>
        <div className="modal__header">
          <div className="modal__title">{title}</div>
          <button type="button" className="modal__close" disabled={busy} onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="utility-body">{children}</div>
      </form>
    </Modal>
  );
}

export function CloudSessionModal({ botId, onClose }: { botId: string; onClose: () => void }) {
  const [goal, setGoal] = useState('');
  const [folder, setFolder] = useState('');
  const [allowLocalEdits, setAllowLocalEdits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <ProjectModal title="Start Claude Cloud session" onClose={onClose} busy={busy} onSubmit={event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError('');
      void featuresApi.startCloudSession(botId, { goal, folder, allowLocalEdits }).then(onClose,
        cause => { setError(cause.message); setBusy(false); });
    }}>
      <p className="cfg-field__hint">Claude runs remotely. Use a project folder linked to GitHub. Claude may sync project files depending on your Claude settings; check the folder before continuing.</p>
      <label>Task<textarea className="text-input" required maxLength={20_000} rows={4} value={goal} onChange={e => setGoal(e.target.value)} /></label>
      <label>Local project folder<input className="text-input" required placeholder="~/Projects/my-project" value={folder} onChange={e => setFolder(e.target.value)} /></label>
      <label className="utility-check"><input type="checkbox" checked={allowLocalEdits} onChange={e => setAllowLocalEdits(e.target.checked)} />
        Allow a fallback agent to edit this local folder if Cloud hits a usage limit</label>
      {error && <p role="alert">{error}</p>}
      <div><button className="btn btn--primary" disabled={busy || !goal.trim() || !folder.trim()}>{busy ? 'Starting…' : 'Start Cloud session'}</button></div>
    </ProjectModal>
  );
}

export function GitHubRepoModal() {
  const close = () => useStore.getState().setModal(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [push, setPush] = useState(false);
  const [folder, setFolder] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; pushed: boolean; warning?: string }>();
  return (
    <ProjectModal title="Create GitHub repository" onClose={close} busy={busy} onSubmit={event => {
      event.preventDefault(); if (busy || result) return;
      setBusy(true); setError('');
      void featuresApi.createGitHubRepo({ name, description, visibility, folder: push ? folder : undefined, confirmPush: confirmed })
        .then(setResult, cause => setError(cause.message)).finally(() => setBusy(false));
    }}>
      {result ? <>
        <p role="status">{result.pushed ? 'Repository created and branch pushed.' : 'Repository created.'}</p>
        <div><a href={result.url} target="_blank" rel="noreferrer">Open repository on GitHub ↗</a></div>
        {result.warning && <p role="alert">{result.warning}</p>}
      </> : <>
        <label>Repository name<input className="text-input" required maxLength={140} placeholder="my-project or owner/my-project"
          value={name} onChange={e => { setName(e.target.value); setConfirmed(false); }} /></label>
        <label>Description (optional)<textarea className="text-input" rows={2} maxLength={350} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label>Visibility<select className="text-input" value={visibility} onChange={e => { setVisibility(e.target.value === 'public' ? 'public' : 'private'); setConfirmed(false); }}>
          <option value="private">Private</option><option value="public">Public</option>
        </select></label>
        <label className="utility-check"><input type="checkbox" checked={push} onChange={e => { setPush(e.target.checked); setConfirmed(false); }} />Push an existing folder</label>
        {push && <>
          <label>Local folder<input className="text-input" required placeholder="~/Projects/my-project" value={folder} onChange={e => { setFolder(e.target.value); setConfirmed(false); }} /></label>
          <p className="cfg-field__hint">Pushes the current branch and its history. If the folder has no Git repository, creates one and commits files not excluded by Git ignore rules.</p>
          <label className="utility-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            I reviewed the files and history and want to publish them to this {visibility} repository.</label>
        </>}
        {error && <p role="alert">{error}</p>}
        <div><button className="btn btn--primary" disabled={busy || !name.trim() || (push && (!folder.trim() || !confirmed))}>{busy ? 'Creating…' : 'Create repository'}</button></div>
      </>}
    </ProjectModal>
  );
}
