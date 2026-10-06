// Public entry point of the chat core. The implementation is split into:
// - prompts.ts: system prompt templates and their assembly
// - discovery-policy.ts: browser tool policy for read-only discovery chats
// - chat-registry.ts: in-memory turn reservations, active sessions, queues and SSE listeners
// - session-store.ts: session files (path cache, titles, messages, branching, create/delete)
// - turn-runner.ts: running one agent turn
// - metrics.ts: per-turn evaluation metrics (JSONL)

export {
    abortChatTurn,
    beginChatDeletion,
    cancelChatDeletion,
    ChatBusyError,
    getChatQueueState,
    isChatBusy,
    isChatDeleting,
    publishChatUpdate,
    queueChatFollowUp,
    subscribeToChatUpdates,
    type ChatUpdateEvent,
} from "./chat-registry";
export { createDiscoveryBrowserPolicy, DISCOVERY_BROWSER_TOOLS } from "./discovery-policy";
export { createChat, getChatMessages, getChatView, listChats, removeChatSession } from "./session-store";
export { branchChatForTurn, runChatTurn, startBranchedChatTurn, startChatTurn } from "./turn-runner";
