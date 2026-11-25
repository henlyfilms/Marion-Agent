import type { ChatProvider } from '@shared/types';

const FILES: Record<ChatProvider, string> = { local: 'qwen-color', codex: 'codex', gemini: 'gemini-color', claude: 'claude-color' };

/** The real brand mark for a model provider, the same files the model picker uses. */
export function ProviderLogo({ provider, size = 16, className = '' }: { provider: ChatProvider; size?: number; className?: string }) {
  return <img className={`provider-icon provider-icon--${provider} ${className}`} src={`/providers/${FILES[provider]}.svg`} alt="" width={size} height={size} draggable={false} />;
}
