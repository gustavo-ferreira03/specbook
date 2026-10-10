export function LogoMark({ className = "size-7", inverse = false }: { className?: string; inverse?: boolean }) {
    return <img src={inverse ? "/specbook-chat-icon.svg" : "/specbook-logo.svg"} alt="" aria-hidden="true" className={`select-none ${className}`} draggable={false} />;
}

export function Brand({ large = false }: { large?: boolean }) {
    return <span className="flex items-center gap-1.5 text-ink"><LogoMark className={`${large ? "size-8" : "size-7"} dark:invert`} /><span className="wordmark">specbook</span></span>;
}
