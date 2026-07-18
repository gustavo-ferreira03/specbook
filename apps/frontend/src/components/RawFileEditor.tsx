"use client";

import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-robotframework";
import Editor from "react-simple-code-editor";
import { Label } from "@/components/ui/label";

export type EditorLanguage = "yaml" | "robotframework";

export function RawFileEditor({
    id,
    label,
    language,
    value,
    onChange,
    disabled,
    rows = 14,
}: {
    id: string;
    label: string;
    language: EditorLanguage;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    rows?: number;
}) {
    const grammar = Prism.languages[language];
    return (
        <div className="min-w-0">
            <Label htmlFor={id} className="text-[0.625rem] font-bold tracking-[0.06em] text-ink-faint uppercase">
                {label}
            </Label>
            <div
                className="code-editor mt-2 overflow-auto rounded-[9px] border border-line bg-surface-soft"
                style={{ minHeight: `${rows * 1.25}rem`, maxHeight: "26rem" }}
            >
                <Editor
                    textareaId={id}
                    value={value}
                    onValueChange={onChange}
                    highlight={(code) => (grammar ? Prism.highlight(code, grammar, language) : code)}
                    disabled={disabled}
                    padding={12}
                    textareaClassName="focus:outline-none"
                    className="min-h-full font-mono text-[0.71875rem] leading-5 text-ink"
                    style={{ overflow: "visible" }}
                />
            </div>
        </div>
    );
}
