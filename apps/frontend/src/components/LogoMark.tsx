export function LogoMark({ className = "size-7", inverse = false }: { className?: string; inverse?: boolean }) {
    return <img src={inverse ? "/specbook-chat-icon.svg" : "/specbook-logo.svg"} alt="" aria-hidden="true" className={`select-none ${className}`} draggable={false} />;
}

export function Brand({ large = false }: { large?: boolean }) {
    return <span className={`flex items-center text-ink ${large ? "gap-2" : "gap-1.5"}`}><LogoMark className={`${large ? "size-10" : "size-7"} dark:invert`} /><span className={large ? "wordmark wordmark-lg" : "wordmark"}>specbook</span></span>;
}
