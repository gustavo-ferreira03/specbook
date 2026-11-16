import Link from "next/link";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { ActivityStory } from "@/lib/types";

const NO_OMISSIONS: string[] = [];

export const StoryTimeline = function StoryTimeline({
  story,
  projectId,
  omit = NO_OMISSIONS,
}: {
  story: ActivityStory;
  projectId: string;
  omit?: string[];
}) {
  const timeline = story.timeline
    .filter((event) => !omit.includes(event.detail))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!timeline.length) {
    return null;
  }
  return (
    <ol
      className="border-line space-y-4 border-l pl-4"
      aria-label="What happened"
    >
      {timeline.map((event) => (
        <li key={event.id}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-body text-ink font-medium">{event.label}</h3>
            {event.runId ? (
              <time
                dateTime={event.createdAt}
                className="text-meta text-ink-subtle"
              >
                {formatDateTime(event.createdAt, { seconds: true })}
              </time>
            ) : (
              <RelativeTime
                value={event.createdAt}
                className="text-meta text-ink-subtle"
              />
            )}
          </div>
          {event.detail && (
            <p className="text-body text-ink-muted mt-1">{event.detail}</p>
          )}
          {event.specId && event.runId && (
            <Link
              className="text-meta text-ink-muted hover:text-ink mt-1 inline-block underline underline-offset-2"
              href={`/p/${projectId}/specs/${event.specId}#run-${event.runId}`}
            >
              View this test run
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
};

export const StoryDetails = function StoryDetails({
  story,
  projectId,
  onDecision,
  showDecisions = true,
}: {
  story: ActivityStory;
  projectId: string;
  onDecision: (id: string) => void;
  showDecisions?: boolean;
}) {
  return (
    <div className="space-y-5">
      {story.summary &&
        !story.timeline.some((event) => event.detail === story.summary) && (
          <p className="text-body text-ink">{story.summary}</p>
        )}
      <StoryTimeline story={story} projectId={projectId} />
      {story.nextStep && (
        <p className="text-body text-ink">
          <span className="font-medium">Next: </span>
          {story.nextStep}
        </p>
      )}
      {((showDecisions && story.inboxIds.length > 0) || story.specId) && (
        <div className="flex flex-wrap gap-2">
          {showDecisions && story.inboxIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDecision(story.inboxIds[0])}
            >
              View the decision
            </Button>
          )}
          {story.specId && (
            <Button asChild variant="ghost" size="sm">
              <Link
                href={`/p/${projectId}/specs/${story.specId}${story.runId ? `#run-${story.runId}` : ""}`}
              >
                View the Spec
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
