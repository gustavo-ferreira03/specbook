export function LogoMark({ className = "size-7", inverse = false }: { className?: string; inverse?: boolean }) {
    return <img src={inverse ? "/specbook-chat-icon.svg" : "/specbook-logo.svg"} alt="" aria-hidden="true" className={`select-none ${className}`} draggable={false} />;
}
