"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const SPECS = [
    {
        path: "authentication/reject-invalid-sign-in-credentials/spec.yml",
        title: "Reject invalid sign-in credentials",
        steps: ["Open the sign-in page", "Submit invalid credentials", "See the rejection and remain on the sign-in page"],
        expected: "The sign-in page remains open and displays “Email or password is incorrect.”",
        duration: "1.0s",
    },
    {
        path: "authentication/sign-in-with-valid-credentials/spec.yml",
        title: "Sign in with valid credentials",
        steps: ["Open the Specbook sign-in page", "Enter the saved administrator email and password", "See the Sauce Demo project workspace"],
        expected: "The sign-in form submits and the Sauce Demo project workspace appears with project navigation and its dashboard.",
        duration: "1.5s",
    },
    {
        path: "home/home-dashboard-shows-the-passing-headline/spec.yml",
        title: "Home dashboard shows the passing headline",
        steps: ["Open the Specbook sign-in page", "Sign in with the saved administrator account", "Open the project Home dashboard", "Observe the passing-Spec headline"],
        expected: "The Home dashboard displays the headline “1 of 1 Spec passing”.",
        duration: "0.9s",
    },
    {
        path: "specs/open-a-spec-and-run-it-to-a-visible-result/spec.yml",
        title: "Open a Spec and run it to a visible result",
        steps: ["Sign in to the Sauce Demo project", "Open the existing Spec from the Specs list", "Run the Spec again", "See the updated pass status, unchanged Spec step, and additional run in history"],
        expected: "The Spec detail shows “Last run passed” and the newest run in the history is from just now and marked “Passed”.",
        duration: "4.2s",
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
