import { selectedLocalModel } from './models.js';
import { getChatProvider, subscriptionSelection } from './subscriptions.js';
import { isDesktop } from '../lib/desktop-access.js';
export function chatModelForBot(bot) {
    const { user_id, chat_provider, chat_model, chat_model_label, chat_effort } = bot;
    if (bot.kind !== 'room' && isDesktop) {
        if (chat_provider && chat_provider !== 'local' && chat_model) {
            return { provider: chat_provider, model: chat_model, effort: chat_effort, label: chat_model_label ?? undefined };
        }
        if (!chat_provider) {
            const provider = getChatProvider(user_id);
            if (provider !== 'local')
                return subscriptionSelection(user_id, provider);
        }
    }
    return {
        provider: 'local',
        model: chat_provider === 'local' && chat_model ? chat_model : selectedLocalModel(user_id),
        effort: bot.effort,
    };
}
//# sourceMappingURL=chat-model.js.map