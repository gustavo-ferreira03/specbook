type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): number {
    const value = process.env.LOG_LEVEL?.toLowerCase();
    if (value === "silent") return Number.POSITIVE_INFINITY;
    return value && value in LEVELS ? LEVELS[value as LogLevel] : LEVELS.info;
}

const threshold = configuredLevel();

function serializeError(error: unknown, depth = 0): unknown {
    if (!(error instanceof Error)) return error;
    return { name: error.name, message: error.message, stack: error.stack,
        ...(error.cause !== undefined && depth < 3 ? { cause: serializeError(error.cause, depth + 1) } : {}) };
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVELS[level] < threshold) return;
    const entry: LogFields = { time: new Date().toISOString(), level, msg: message };
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            entry[key] = key === "error" || value instanceof Error ? serializeError(value) : value;
        }
    }
    let line: string;
    try {
        line = JSON.stringify(entry);
    } catch {
        line = JSON.stringify({ time: entry.time, level, msg: message, fields: "[unserializable]" });
    }
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
    debug: (message: string, fields?: LogFields) => write("debug", message, fields),
    info: (message: string, fields?: LogFields) => write("info", message, fields),
    warn: (message: string, fields?: LogFields) => write("warn", message, fields),
    error: (message: string, fields?: LogFields) => write("error", message, fields),
};
