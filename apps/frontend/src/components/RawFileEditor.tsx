"use client";

import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-robotframework";
import { FileCode2 } from "lucide-react";
import Editor from "react-simple-code-editor";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type EditorLanguage = "yaml" | "robotframework";

function highlightCode(source: string, language: EditorLanguage): string {
    return Prism.highlight(source, Prism.languages[language], language);
}

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
    return (
        <div className="min-w-0">
            <Label htmlFor={id} className="flex items-center gap-1.5 font-mono text-[0.6875rem] font-semibold text-ink-soft">
                <FileCode2 size={12} aria-hidden />
                <span>{label}</span>
            </Label>
            <div
                className={cn(
                    "syntax-code mt-2 overflow-auto rounded-lg border border-line-strong bg-code-canvas transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-ring/10",
                    disabled && "opacity-65",
                )}
                style={{ minHeight: `${rows * 1.25}rem`, maxHeight: "26rem" }}
            >
                <Editor
                    textareaId={id}
                    value={value}
                    onValueChange={onChange}
                    highlight={(code) => highlightCode(code, language)}
                    disabled={disabled}
                    padding={12}
                    textareaClassName="focus:outline-none"
                    className="min-h-full font-mono text-[0.71875rem] leading-5 text-ink"
                    style={{ overflow: "visible", tabSize: 4 }}
                />
            </div>
        </div>
    );
}

export function HighlightedCode({
    label,
    language,
    source,
    className,
}: {
    label: string;
    language: EditorLanguage;
    source: string;
    className?: string;
}) {
    return (
        <pre
            aria-label={label}
            tabIndex={0}
            className={cn(
                "syntax-code max-w-full overflow-x-auto rounded-lg bg-code-canvas p-3 font-mono text-[0.65625rem] leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
                className,
            )}
        >
            <code dangerouslySetInnerHTML={{ __html: highlightCode(source, language) }} />
        </pre>
    );
}
