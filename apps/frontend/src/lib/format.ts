const LOCALE = "en-US";

const dateFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium" });
const shortDateFormatter = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
const preciseDateTimeFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "medium" });
const timeFormatter = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const numberFormatter = new Intl.NumberFormat(LOCALE);

type DateInput = string | number | Date;

function toDate(value: DateInput): Date {
    return value instanceof Date ? value : new Date(value);
}

/** "Sep 28, 2026" */
export function formatDate(value: DateInput): string {
    return dateFormatter.format(toDate(value));
}

/** "Sep 28" */
export function formatShortDate(value: DateInput): string {
    return shortDateFormatter.format(toDate(value));
}

/** "Sep 28, 2026, 3:04 PM" */
export function formatDateTime(value: DateInput, options: { seconds?: boolean } = {}): string {
    return (options.seconds ? preciseDateTimeFormatter : dateTimeFormatter).format(toDate(value));
}

/** "03:04 PM" */
export function formatTime(value: DateInput): string {
    return timeFormatter.format(toDate(value));
}

export function formatNumber(value: number): string {
    return numberFormatter.format(value);
}

/** "1 Spec", "3 Specs" */
export function countLabel(count: number, noun: string, plural = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : plural}`;
}

const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.345],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago"; older than a year falls back to formatDate. */
export function formatRelative(value: DateInput, now: number = Date.now()): string {
    const date = toDate(value);
    let delta = (date.getTime() - now) / 1000;
    if (Math.abs(delta) < 45) return "just now";
    for (const [unit, size] of RELATIVE_STEPS) {
        if (Math.abs(delta) < size) {
            if (unit === "year") break;
            return relativeFormatter.format(Math.round(delta), unit);
        }
        delta /= size;
        if (unit === "month" && Math.abs(delta) >= 1) return formatDate(date);
    }
    return formatDate(date);
}

/** "850ms", "2.4s", "1m 05s" */
export function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.round((durationMs % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
