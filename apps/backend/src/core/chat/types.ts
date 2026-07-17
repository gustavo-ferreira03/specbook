export interface ChatMessageRecord {
    id: string;
    conversationId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
}
