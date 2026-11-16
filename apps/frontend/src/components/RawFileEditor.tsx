"use client";

import { FileCode2 } from "lucide-react";
import Prism from "prismjs";
import Editor from "react-simple-code-editor";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Prism language components extend the global Prism, so they load after it.
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-typescript";

export type EditorLanguage = "yaml" | "typescript";

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
      <Label
        htmlFor={id}
        className="text-control text-ink-muted flex items-center gap-1.5 font-mono font-semibold"
      >
        <FileCode2 size={12} aria-hidden />
        <span>{label}</span>
      </Label>
      <div
        className={cn(
          "syntax-code border-line-strong bg-code-canvas focus-within:border-primary/45 focus-within:ring-ring/10 mt-2 overflow-auto rounded-lg border transition-[border-color,box-shadow] focus-within:ring-2",
          disabled && "opacity-65"
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
          className="text-control text-ink min-h-full font-mono leading-5"
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
        "syntax-code bg-code-canvas text-meta text-ink focus-visible:ring-ring/20 max-w-full overflow-x-auto rounded-lg p-3 font-mono leading-5 outline-none focus-visible:ring-2",
        className
      )}
    >
      <code
        dangerouslySetInnerHTML={{ __html: highlightCode(source, language) }}
      />
    </pre>
  );
}
