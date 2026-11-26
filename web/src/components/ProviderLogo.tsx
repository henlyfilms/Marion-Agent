import type { ChatProvider } from '@shared/types';
import { Icon } from './Icon';

const FILES: Record<ChatProvider, string> = { local: 'qwen-color', codex: 'codex', gemini: 'gemini-color', claude: 'claude-color' };

/** The real brand mark for a model provider, the same files the model picker uses. */
export function ProviderLogo({ provider, size = 16, className = '' }: { provider: ChatProvider; size?: number; className?: string }) {
  return <img className={`provider-icon provider-icon--${provider} ${className}`} src={`/providers/${FILES[provider]}.svg`} alt="" width={size} height={size} draggable={false} />;
}

/** The icon the model picker shows for a model: the provider's mark, or a computer for local models that aren't Qwen. */
export function ModelIcon({ provider, model, size = 16 }: { provider: ChatProvider; model?: string; size?: number }) {
  if (provider === 'local' && model && !/qwen/i.test(model)) return <Icon name="monitor" size={size} />;
  return <ProviderLogo provider={provider} size={size} />;
}
