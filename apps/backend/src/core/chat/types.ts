export interface ChatMessageRecord {
    id: string;
    chatId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
}
