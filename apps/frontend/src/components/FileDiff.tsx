interface DiffLine {
    kind: "context" | "added" | "removed";
    text: string;
    before: number;
    after: number;
}

export interface ProposalFile {
    path: string;
    before: string | null;
    after: string;
}

export function fileDiff(before: string, after: string) {
    const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
    const left = oldLines.slice(prefix, oldLines.length - suffix);
    const right = newLines.slice(prefix, newLines.length - suffix);
    const lines: DiffLine[] = [];
    let beforeLine = 1;
    let afterLine = 1;
    const add = (kind: DiffLine["kind"], text: string) => {
        lines.push({ kind, text, before: beforeLine, after: afterLine });
        if (kind !== "added") beforeLine++;
        if (kind !== "removed") afterLine++;
    };
    oldLines.slice(0, prefix).forEach((line) => add("context", line));
    // Bound memory for unusually large replacements; unchanged edges still stay context.
    if (!left.length || !right.length || left.length + right.length > 4000 || left.length * right.length > 1_000_000) {
        left.forEach((line) => add("removed", line));
        right.forEach((line) => add("added", line));
    } else {
        const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
        for (let old = left.length - 1; old >= 0; old--) {
            for (let next = right.length - 1; next >= 0; next--) {
                lengths[old][next] = left[old] === right[next] ? lengths[old + 1][next + 1] + 1 : Math.max(lengths[old + 1][next], lengths[old][next + 1]);
            }
        }
        let old = 0;
        let next = 0;
        while (old < left.length || next < right.length) {
            if (old < left.length && next < right.length && left[old] === right[next]) {
                add("context", left[old++]);
                next++;
            } else if (old < left.length && (next === right.length || lengths[old + 1][next] >= lengths[old][next + 1])) {
                add("removed", left[old++]);
            } else {
                add("added", right[next++]);
            }
        }
    }
    oldLines.slice(oldLines.length - suffix).forEach((line) => add("context", line));
    const ranges: { start: number; end: number }[] = [];
    lines.forEach((line, index) => {
        if (line.kind === "context") return;
        const start = Math.max(0, index - 3);
        const end = Math.min(lines.length, index + 4);
        const previous = ranges.at(-1);
        if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
        else ranges.push({ start, end });
    });
    const hunks = ranges.map(({ start, end }) => {
        const content = lines.slice(start, end);
        const oldCount = content.filter((line) => line.kind !== "added").length;
        const newCount = content.filter((line) => line.kind !== "removed").length;
        const oldStart = content[0].before - (oldCount === 0 ? 1 : 0);
        const newStart = content[0].after - (newCount === 0 ? 1 : 0);
        return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines: content };
    });
    return { hunks, added: lines.filter((line) => line.kind === "added").length, removed: lines.filter((line) => line.kind === "removed").length };
}

export function FileDiff({ file }: { file: ProposalFile }) {
    const diff = fileDiff(file.before ?? "", file.after);
    return (
        <section aria-label={`${file.path} changes`} className="min-w-0 overflow-hidden rounded-lg border border-line bg-code-canvas">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-soft px-3 py-2">
                <h3 className="break-all font-mono text-meta font-medium text-ink">{file.path}</h3>
                <div className="flex items-center gap-3 font-mono text-meta">
                    {file.before === null && <span className="font-sans text-ink-muted">New file</span>}
                    {diff.added > 0 && <span className="text-success" aria-label={`${diff.added} added lines`}>+{diff.added}</span>}
                    {diff.removed > 0 && <span className="text-danger" aria-label={`${diff.removed} removed lines`}>−{diff.removed}</span>}
                </div>
            </div>
            {diff.hunks.length === 0 ? <p className="px-3 py-3 text-body text-ink-muted">No changes.</p> : (
                <pre tabIndex={0} aria-label={`${file.path} unified diff`} className="max-h-96 overflow-auto font-mono text-meta leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring/20">
                    <code className="block min-w-max py-1">{diff.hunks.map((hunk, index) => (
                        <span key={index} className="block">
                            <span className="block bg-surface-soft px-3 py-1 text-ink-subtle">{hunk.header}</span>
                            {hunk.lines.map((line, lineIndex) => (
                                <span key={lineIndex} className="block">
                                    <span className={`grid grid-cols-[3rem_3rem_1.5rem_1fr] pr-3 ${line.kind === "added" ? "bg-success-soft text-success" : line.kind === "removed" ? "bg-danger-soft text-danger" : ""}`}>
                                        <span aria-hidden="true" className="select-none pr-2 text-right text-ink-subtle">{line.kind !== "added" ? line.before : ""}</span>
                                        <span aria-hidden="true" className="select-none pr-2 text-right text-ink-subtle">{line.kind !== "removed" ? line.after : ""}</span>
                                        <span className="select-none text-center">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
                                        <span>{line.text.replace(/\r?\n$/, "") || " "}</span>
                                    </span>
                                    {!line.text.endsWith("\n") && <span className="block px-3 text-ink-subtle">{"\\ No newline at end of file"}</span>}
                                </span>
                            ))}
                        </span>
                    ))}</code>
                </pre>
            )}
        </section>
    );
}
