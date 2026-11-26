import { memo, useEffect, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard';

type HastNode = { type?: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };

/** Raw text of a hast subtree (exactly what is inside the fence, no rendered markup). */
function hastText(n: HastNode | undefined): string {
  if (!n) return '';
  if (typeof n.value === 'string') return n.value;
  return (n.children ?? []).map(hastText).join('');
}

function codeInfo(node: HastNode | undefined): { text: string; lang: string } {
  const code = node?.children?.find(c => c.tagName === 'code') ?? node;
  const cls = code?.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : [];
  const lang = classes.find(c => c.startsWith('language-'))?.slice(9) ?? '';
  return { text: hastText(code), lang };
}

/** Fenced code box: language label top-left, Copy button top-right, scrollable body. */
function CodeBlock({ node, children, ...rest }: ComponentProps<'pre'> & { node?: unknown }) {
  const { text, lang } = codeInfo(node as HastNode | undefined);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    clearTimeout(timer.current);
    try { await copyText(text); setState('copied'); } catch { setState('failed'); }
    timer.current = setTimeout(() => setState('idle'), 1800);
  };
  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{lang}</span>
        <button type="button" className="md-code__copy" onClick={onCopy} aria-label="Copy code" data-state={state}>
          {state === 'copied' ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}</span>
        </button>
      </div>
      <pre {...rest} tabIndex={0}>{children}</pre>
    </div>
  );
}

const components: Components = {
  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...props }) => (
    <div className="md-table"><table {...props} /></div>
  ),
  pre: CodeBlock,
};

/** Assistant message markdown: paragraphs, lists, blockquotes, inline code, copyable code blocks, tables. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
