import Link from "next/link";
import { RelativeTime } from "@/components/RelativeTime";
import { TechnicalDetails } from "@/components/TechnicalDetails";
import { Button } from "@/components/ui/button";
import type { ActivityStory } from "@/lib/types";
import { formatDateTime } from "@/lib/format";

export function StoryTimeline({ story, projectId, omit = [] }: { story: ActivityStory; projectId: string; omit?: string[] }) {
    const timeline = story.timeline.filter((event) => !omit.includes(event.detail)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!timeline.length) return null;
    return <ol className="space-y-4 border-l border-line pl-4" aria-label="What happened">{timeline.map((event) => <li key={event.id}><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 className="text-body font-medium text-ink">{event.label}</h3>{event.runId ? <time dateTime={event.createdAt} className="text-meta text-ink-subtle">{formatDateTime(event.createdAt, { seconds: true })}</time> : <RelativeTime value={event.createdAt} className="text-meta text-ink-subtle" />}</div>{event.detail && <p className="mt-1 text-body text-ink-muted">{event.detail}</p>}{event.specId && event.runId && <Link className="mt-1 inline-block text-meta text-ink-muted underline underline-offset-2 hover:text-ink" href={`/p/${projectId}/specs/${event.specId}#run-${event.runId}`}>View this test run</Link>}</li>)}</ol>;
}

export function StoryDetails({ story, projectId, onDecision, showDecisions = true }: { story: ActivityStory; projectId: string; onDecision: (id: string) => void; showDecisions?: boolean }) {
    return <div className="space-y-5">
        {story.summary && !story.timeline.some((event) => event.detail === story.summary) && <p className="text-body text-ink">{story.summary}</p>}
        <StoryTimeline story={story} projectId={projectId} />
        {story.nextStep && <p className="text-body text-ink"><span className="font-medium">Next: </span>{story.nextStep}</p>}
        {((showDecisions && story.inboxIds.length > 0) || story.specId) && <div className="flex flex-wrap gap-2">{showDecisions && story.inboxIds.length > 0 && <Button variant="outline" size="sm" onClick={() => onDecision(story.inboxIds[0])}>View the decision</Button>}{story.specId && <Button asChild variant="ghost" size="sm"><Link href={`/p/${projectId}/specs/${story.specId}${story.runId ? `#run-${story.runId}` : ""}`}>View the Spec</Link></Button>}</div>}
        {story.technicalDetails && <TechnicalDetails><pre tabIndex={0} aria-label="Technical activity details" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code-canvas p-3 font-mono text-meta text-ink-muted">{story.technicalDetails}</pre></TechnicalDetails>}
    </div>;
}
