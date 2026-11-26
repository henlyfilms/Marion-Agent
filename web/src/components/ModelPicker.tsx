import { useCallback, useEffect, useRef, useState } from 'react';
import { localEfforts, type Bot, type ChatModel, type ChatModelSelection, type ChatModelSettings, type ChatProvider } from '@shared/types';
import { useConfigUI } from '../configStore';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';
import { LocalMemory } from './LocalMemory';
import { Menu, type MenuItem } from './Menu';
import { ModelIcon } from './ProviderLogo';

const providers: ChatProvider[] = ['local', 'codex', 'gemini', 'claude'];
const names = { local: 'Local models', codex: 'Codex', gemini: 'Gemini · Antigravity', claude: 'Claude Code' };
const ProviderIcon = ModelIcon;

/** Model lists are checked once per app session (shared by every chat), so the menu opens already full. */
let discoveredOnce = false;

const effortLabel = (effort: string | null) => effort === null ? 'Default' : effort === 'xhigh'
  ? 'Extra high' : effort.substring(0, 1).toUpperCase() + effort.substring(1);

export function ModelPicker({ bot, inputId }: { bot: Bot; inputId: string }) {
  const [data, setData] = useState<ChatModelSettings>();
  const [menu, setMenu] = useState<'model' | 'effort' | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const saving = useStore(s => !!s.savingChatModels[bot.id]);
  const [error, setError] = useState('');
  const version = useRef(0);
  const discovered = useRef(discoveredOnce);
  const appSettingsOpen = useConfigUI(s => s.appSettings !== null);
  const settingsVersion = useStore(s => s.modelSettingsVersion);

  const refresh = useCallback(async (discover = false) => {
    const request = ++version.current;
    setError('');
    setDiscovering(discover);
    try {
      const result = await configApi.chatModels(bot.id, discover);
      if (request !== version.current) return;
      if (discover) { discovered.current = true; discoveredOnce = true; }
      setData(result);
    } catch (cause) {
      if (request === version.current) setError((cause as Error).message);
    } finally {
      if (request === version.current) setDiscovering(false);
    }
  }, [bot.id]);

  useEffect(() => {
    if (!appSettingsOpen) void refresh(discovered.current);
    return () => { version.current++; };
  }, [refresh, appSettingsOpen, settingsVersion, bot.chatModel?.provider, bot.chatModel?.model]);
  // Check which models are available quietly in the background, so opening the menu never waits.
  useEffect(() => {
    if (discovered.current) return;
    const timer = window.setTimeout(() => { if (!discovered.current) void refresh(true); }, 1800);
    return () => clearTimeout(timer);
  }, [refresh]);

  const selection = bot.chatModel?.model ? bot.chatModel
    : data?.selection.provider === bot.chatModel?.provider ? data?.selection : bot.chatModel ?? data?.selection;
  const active = data?.models.find(model => model.provider === selection?.provider && model.id === selection.model);
  const currentEffort = selection?.effort ?? null;
  const modelLabel = selection?.label || active?.label || selection?.model || (selection ? names[selection.provider] : 'Choose model');
  const save = async (choice: ChatModelSelection) => {
    if (saving) return;
    setError('');
    try {
      await useStore.getState().saveChatModel(bot.id, choice);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const pickModel = (model: ChatModel) => {
    const sameProvider = model.provider === selection?.provider;
    const effort = sameProvider && currentEffort && model.efforts.includes(currentEffort) ? currentEffort : model.defaultEffort;
    return save({ provider: model.provider, model: model.id, effort });
  };

  const items: MenuItem[] = providers.flatMap(provider => {
    if (bot.kind === 'room' && provider !== 'local') return [];
    const models = discovered.current ? data?.models.filter(model => model.provider === provider) ?? [] : [];
    const reason = data?.unavailable[provider];
    const options: MenuItem[] = models.map(model => ({
      group: names[provider], label: model.label, detail: model.label === model.id ? undefined : model.id,
      icon: <ProviderIcon provider={provider} model={model.id} />,
      checked: selection?.provider === provider && selection.model === model.id,
      onSelect: () => pickModel(model),
    }));
    if (reason) options.push({ group: names[provider], label: reason, disabled: true, icon: <ProviderIcon provider={provider} />, onSelect: () => {} });
    return options;
  });
  items.push({ label: discovering ? 'Checking model availability…' : 'Refresh models', separator: items.length > 0, disabled: discovering, icon: <Icon name="refresh" />, onSelect: () => refresh(true) });
  const effortItems = (active?.efforts ?? (selection?.provider === 'local' ? localEfforts : [])).map(effort => ({
    label: effortLabel(effort), checked: currentEffort === effort,
    onSelect: () => selection && save({ ...selection, effort }),
  }));

  const toggle = (choice: 'model' | 'effort') => {
    setMenu(menu === choice ? null : choice);
    if (choice === 'model' && menu !== 'model' && !discovering && !discovered.current) void refresh(true);
  };

  return (
    <div className="chat-model" role="group" aria-label="Message model and effort">
      <span className="chat-model__anchor">
        <button type="button" className="chat-model__trigger" aria-label={`Model: ${modelLabel}`}
          aria-haspopup="menu" aria-expanded={menu === 'model'} aria-controls={inputId} disabled={saving} onClick={() => toggle('model')}
          title={selection?.model || 'Choose model'}>
          {selection && <ProviderIcon provider={selection.provider} model={selection.model} />}
          <span>{modelLabel}</span>
          <Icon name="chev_down" size={12} />
        </button>
        {menu === 'model' && <Menu items={items} label="Models" placement="above" className="chat-model__menu" onClose={() => setMenu(null)} />}
      </span>
      {bot.kind !== 'room' && <span className="chat-model__anchor">
        <button type="button" className="chat-model__trigger" aria-label={`Effort: ${effortLabel(currentEffort)}`}
          aria-haspopup="menu" aria-expanded={menu === 'effort'} aria-controls={inputId} disabled={saving || !effortItems.length}
          title="Reasoning effort" onClick={() => toggle('effort')}>
          <span>{effortLabel(currentEffort)}</span><Icon name="chev_down" size={12} />
        </button>
        {menu === 'effort' && <Menu items={effortItems} label="Reasoning effort" placement="above" className="chat-model__effort-menu" onClose={() => setMenu(null)} />}
      </span>}
      {selection?.provider === 'local' && !appSettingsOpen && <LocalMemory compact />}
      {error && <div className="chat-model__error" role="alert">{error}<button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></div>}
    </div>
  );
}
