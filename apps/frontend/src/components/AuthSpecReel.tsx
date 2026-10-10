"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const SPECS = [
    {
        path: "cart/removing-items/spec.yml",
        title: "Removing an item updates the cart badge",
        steps: ["Sign in as the standard user", "Add the backpack and the bike light to the cart", "Remove the backpack from the cart"],
        expected: "The badge shows 1 and the bike light stays in the cart.",
        duration: "1.1s",
    },
    {
        path: "login/locked-out-user/spec.yml",
        title: "A locked out user cannot sign in",
        steps: ["Open the login page", "Sign in as the locked out user", "Read the error under the form"],
        expected: "The user stays on the login page and sees that the account is locked.",
        duration: "0.8s",
    },
    {
        path: "checkout/order-total/spec.yml",
        title: "The order total includes tax",
        steps: ["Add two items to the cart", "Start checkout and enter a shipping address", "Open the order overview"],
        expected: "The total equals the item subtotal plus the displayed tax.",
        duration: "2.4s",
    },
    {
        path: "inventory/sorting/spec.yml",
        title: "Sorting by price puts the cheapest item first",
        steps: ["Sign in as the standard user", "Sort the inventory from low to high price"],
        expected: "The onesie is listed first and prices never decrease down the list.",
        duration: "0.9s",
    },
];

const STEP_MS = 1600;
const RESULT_MS = 5000;
const FADE_MS = 700;

export function AuthSpecReel() {
    const [specIndex, setSpecIndex] = useState(0);
    const [done, setDone] = useState(0);
    const [visible, setVisible] = useState(true);
    const [still, setStill] = useState(false);
    const spec = SPECS[specIndex];
    const finished = done >= spec.steps.length;

    useEffect(() => {
        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        const sync = () => setStill(query.matches);
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
        if (still) return;
        if (!visible) {
            const timer = window.setTimeout(() => {
                setSpecIndex((index) => (index + 1) % SPECS.length);
                setDone(0);
                setVisible(true);
            }, FADE_MS);
            return () => window.clearTimeout(timer);
        }
        const timer = window.setTimeout(() => (finished ? setVisible(false) : setDone((count) => count + 1)), finished ? RESULT_MS : STEP_MS);
        return () => window.clearTimeout(timer);
    }, [still, visible, finished, done]);

    const shown = still ? SPECS[0] : spec;
    const doneCount = still ? shown.steps.length : done;
    return (
        <div className={cn("w-full max-w-[420px] transition-opacity duration-[700ms] ease-[cubic-bezier(0.22,1,0.36,1)]", visible || still ? "opacity-100" : "opacity-0")}>
            <p className="font-mono text-meta text-(--panel-fg)/60">{shown.path}</p>
            <h2 className="mt-3 text-title text-(--panel-fg)">{shown.title}</h2>
            <ol className="mt-8 space-y-3">
                {shown.steps.map((step, index) => {
                    const state = index < doneCount ? "done" : index === doneCount ? "running" : "pending";
                    return (
                        <li key={`${shown.path}-${index}`} className={cn("flex items-start gap-3 text-body transition-colors duration-300", state === "pending" ? "text-(--panel-fg)/45" : "text-(--panel-fg)/85")}>
                            <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-md border border-(--panel-fg)/25 text-meta">{index + 1}</span>
                            <span className="flex-1 pt-0.5">{step}</span>
                            <span className="mt-1 flex size-[15px] shrink-0 items-center justify-center">
                                {state === "done" && <Check size={15} strokeWidth={2.5} aria-hidden="true" className="auth-step-check text-(--panel-fg)" />}
                                {state === "running" && <LoaderCircle size={14} aria-hidden="true" className="animate-spin text-(--panel-fg)/60" />}
                            </span>
                        </li>
                    );
                })}
            </ol>
            <div className="mt-8 rounded-xl border border-(--panel-fg)/20 px-4 py-3.5">
                <p className="flex items-center gap-1.5 text-control font-semibold text-(--panel-fg)"><Target size={14} aria-hidden="true" /> Expected result</p>
                <p className="mt-1.5 text-body text-(--panel-fg)/85">{shown.expected}</p>
            </div>
            <p className={cn("tabular mt-6 flex items-center gap-2 text-meta text-(--panel-fg)/60 transition-opacity duration-300", still || finished ? "opacity-100" : "opacity-0")}>
                <Check size={13} strokeWidth={2.5} aria-hidden="true" /> Passed · {shown.duration}
            </p>
        </div>
    );
}
