"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Announcement {
  pathname: string;
  message: string;
  priority: number;
  host: HTMLElement;
}
const RunAnnouncementContext = createContext({
  announce: (
    _id: string,
    _message: string,
    _priority: number,
    _host: HTMLElement
  ) => {
    /* No provider is mounted yet. */
  },
  remove: (_id: string) => {
    /* No provider is mounted yet. */
  },
});

export const RunStateAnnouncementProvider =
  function RunStateAnnouncementProvider({
    children,
  }: {
    children: React.ReactNode;
  }) {
    const pathname = usePathname();
    const [announcements, setAnnouncements] = useState<
      Record<string, Announcement>
    >({});
    const announce = useCallback(
      (id: string, message: string, priority: number, host: HTMLElement) => {
        setAnnouncements((current) =>
          current[id]?.pathname === pathname &&
          current[id].message === message &&
          current[id].priority === priority &&
          current[id].host === host
            ? current
            : { ...current, [id]: { pathname, message, priority, host } }
        );
      },
      [pathname]
    );
    const remove = useCallback((id: string) => {
      setAnnouncements((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== id)
        )
      );
    }, []);
    const context = useMemo(() => ({ announce, remove }), [announce, remove]);
    const [announcement] = Object.values(announcements)
      .filter((announcementValue) => announcementValue.pathname === pathname)
      .toSorted((a, b) => b.priority - a.priority);
    return (
      <RunAnnouncementContext.Provider value={context}>
        {children}
        {announcement &&
          createPortal(
            <output
              data-run-state-announcement

              aria-live="polite"
              aria-atomic="true"
              className="sr-only block"
            >
              {announcement.message}
            </output>,
            announcement.host
          )}
      </RunAnnouncementContext.Provider>
    );
  };

export const RunStateAnnouncement = function RunStateAnnouncement({
  message,
  priority = 0,
}: {
  message: string;
  priority?: number;
}) {
  const id = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { announce, remove } = useContext(RunAnnouncementContext);
  useEffect(() => {
    if (message && hostRef.current) {
      announce(id, message, priority, hostRef.current);
    }
    return () => remove(id);
  }, [announce, remove, id, message, priority]);
  return <div ref={hostRef} className="contents" />;
};
