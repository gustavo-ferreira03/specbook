export interface ChatMessageRecord {
    id: string;
    chatId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
    canRetry?: boolean;
}

export interface ChatToolStepRecord {
    id: string;
    toolName: string;
    afterMessageId: string | null;
    startedAt: number;
    endedAt: number | null;
}
