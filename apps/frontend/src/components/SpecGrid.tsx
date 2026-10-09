"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export function SpecGrid({ className, fade = true }: { className?: string; fade?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        let frame = 0;
        const move = (event: PointerEvent) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const box = node.getBoundingClientRect();
                node.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
                node.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
                node.dataset.spot = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom ? "on" : "off";
            });
        };
        const leave = () => { node.dataset.spot = "off"; };
        window.addEventListener("pointermove", move, { passive: true });
        document.documentElement.addEventListener("pointerleave", leave);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("pointermove", move);
            document.documentElement.removeEventListener("pointerleave", leave);
        };
    }, []);
    return (
        <div ref={ref} aria-hidden="true" data-spot="off" className={cn("spec-grid pointer-events-none absolute inset-0", fade && "spec-grid-fade", className)}>
            <div className="spec-grid-spot absolute inset-0" />
        </div>
    );
}
