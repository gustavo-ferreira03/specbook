"use client";

import { Copy, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import type { InlineFeedbackValue } from "@/components/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import { requiredValue } from "@/lib/required-value";
import type { AuthUser } from "@/lib/types";

type Role = AuthUser["role"];
interface Members {
  members: (AuthUser & { disabledAt: string | null })[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
}

const RoleSelect = function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: Role;
  onChange: (value: Role) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(role) => onChange(role as Role)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="viewer">Viewer</SelectItem>
        <SelectItem value="editor">Editor</SelectItem>
        <SelectItem value="admin">Admin</SelectItem>
      </SelectContent>
    </Select>
  );
};

export const MembersSettings = function MembersSettings() {
  const [data, setData] = useState<Members | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [inviteUrl, setInviteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<Members>("/settings/members"));
      return true;
    } catch (error) {
      setFeedback({ type: "error", text: errorMessage(error) });
      return false;
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    load();
  }, [load]);
  const mutate = async function mutate(
    path: string,
    method: string,
    body?: unknown
  ) {
    setBusy(true);
    setFeedback(null);
    try {
      await api(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (await load()) {
        setFeedback({ type: "success", text: "Access updated." });
      }
    } catch (error) {
      setFeedback({ type: "error", text: errorMessage(error) });
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(false);
    }
  };
  const invite = async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    setInviteUrl("");
    try {
      const result = await api<{ inviteUrl: string }>("/settings/invitations", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      setInviteUrl(result.inviteUrl);
      setEmail("");
      await load();
    } catch (error) {
      setFeedback({ type: "error", text: errorMessage(error) });
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-10">
      <SettingsSection
        id="invite-member-heading"
        title="Invite a member"
        description="Viewers can read. Editors can change projects and run checks. Admins also manage this instance."
      >
        <form onSubmit={invite}>
          <SettingsRow label="Email" htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="colleague@example.com"
              required
              disabled={busy}
            />
          </SettingsRow>
          <SettingsRow label="Role">
            <RoleSelect
              value={role}
              onChange={setRole}
              disabled={busy}
              label="Invitation role"
            />
          </SettingsRow>
          <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}>
            <Button type="submit" disabled={busy}>
              <UserPlus size={14} /> Create invitation
            </Button>
          </SettingsFooter>
        </form>
        {inviteUrl && (
          <SettingsBlock>
            <p className="text-body text-ink mb-2">
              Send this link to the invited person. It is shown only once.
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Invitation link"
                readOnly
                value={inviteUrl}
                onFocus={(event) => event.target.select()}
              />
              <Button
                variant="outline"
                onClick={() =>
                  (async () => {
                    const resolvedValue = await copyText(inviteUrl);
                    const copied = resolvedValue;
                    return setFeedback({
                      type: copied ? "success" : "error",
                      text: copied
                        ? "Invitation link copied."
                        : "Select and copy the invitation link.",
                    });
                  })()
                }
              >
                <Copy size={14} /> Copy
              </Button>
            </div>
          </SettingsBlock>
        )}
      </SettingsSection>
      <SettingsSection id="members-heading" title="Members">
        {data ? (
          <ul>
            {data.members.map((member) => (
              <li
                key={member.id}
                className="border-line flex flex-wrap items-center gap-3 border-b px-4 py-4 last:border-0 sm:px-5"
              >
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <p className="text-body text-ink font-medium">
                    {member.name}
                  </p>
                  <p className="text-meta text-ink-muted break-all">
                    {member.email}
                  </p>
                </div>
                {member.disabledAt && <Badge variant="neutral">Disabled</Badge>}
                <RoleSelect
                  value={member.role}
                  onChange={(next) =>
                    mutate(apiPath`/settings/members/${member.id}`, "PATCH", {
                      role: next,
                    })
                  }
                  disabled={busy || Boolean(member.disabledAt)}
                  label={`Role for ${member.name}`}
                />
                <Button
                  variant={member.disabledAt ? "outline" : "ghost"}
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    mutate(apiPath`/settings/members/${member.id}`, "PATCH", {
                      disabled: !member.disabledAt,
                    })
                  }
                >
                  {member.disabledAt ? "Restore access" : "Disable access"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <SettingsBlock>
            {feedback?.type === "error" ? (
              <Button variant="outline" onClick={() => load()}>
                Try again
              </Button>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </SettingsBlock>
        )}
      </SettingsSection>
      {Boolean(data?.invitations.length) && (
        <SettingsSection
          id="pending-invitations-heading"
          title="Pending invitations"
        >
          <ul>
            {requiredValue(data).invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="border-line flex items-start gap-3 border-b px-4 py-4 last:border-0 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body text-ink break-all">
                    {invitation.email}
                  </p>
                  <p className="text-meta text-ink-muted mt-1">
                    {invitation.role} · Expires{" "}
                    {formatDateTime(invitation.expiresAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      apiPath`/settings/invitations/${invitation.id}`,
                      "DELETE"
                    )
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
    </div>
  );
};
