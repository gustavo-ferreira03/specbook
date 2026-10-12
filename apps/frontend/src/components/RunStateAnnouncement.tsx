"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

interface Announcement { pathname: string; message: string; priority: number; host: HTMLElement }
const RunAnnouncementContext = createContext({
    announce: (_id: string, _message: string, _priority: number, _host: HTMLElement) => undefined as void,
    remove: (_id: string) => undefined as void,
});

export function RunStateAnnouncementProvider({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [announcements, setAnnouncements] = useState<Record<string, Announcement>>({});
    const announce = useCallback((id: string, message: string, priority: number, host: HTMLElement) => {
        setAnnouncements((current) => current[id]?.pathname === pathname && current[id].message === message && current[id].priority === priority && current[id].host === host ? current : { ...current, [id]: { pathname, message, priority, host } });
    }, [pathname]);
    const remove = useCallback((id: string) => {
        setAnnouncements((current) => { const next = { ...current }; delete next[id]; return next; });
    }, []);
    const context = useMemo(() => ({ announce, remove }), [announce, remove]);
    const announcement = Object.values(announcements).filter((announcement) => announcement.pathname === pathname).sort((a, b) => b.priority - a.priority)[0];
    return <RunAnnouncementContext.Provider value={context}>{children}{announcement && createPortal(<p data-run-state-announcement role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement.message}</p>, announcement.host)}</RunAnnouncementContext.Provider>;
}

export function RunStateAnnouncement({ message, priority = 0 }: { message: string; priority?: number }) {
    const id = useId();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const { announce, remove } = useContext(RunAnnouncementContext);
    useEffect(() => {
        if (message && hostRef.current) announce(id, message, priority, hostRef.current);
        return () => remove(id);
    }, [announce, remove, id, message, priority]);
    return <div ref={hostRef} className="contents" />;
}
