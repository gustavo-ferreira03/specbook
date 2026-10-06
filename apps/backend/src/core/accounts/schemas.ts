import { z } from "zod";

export const roleSchema = z.enum(["admin", "editor", "viewer"]);
export type UserRole = z.infer<typeof roleSchema>;
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const nameSchema = z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f<>]+$/);
const passwordSchema = z.string().min(12).max(128);

export const adminSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }).strict();
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const invitationSchema = z.object({ email: emailSchema, role: roleSchema }).strict();
export const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const acceptInvitationSchema = tokenSchema.extend({ name: nameSchema, password: passwordSchema });
export const memberSchema = z.object({ role: roleSchema.optional(), disabled: z.boolean().optional() }).strict()
    .refine((value) => value.role !== undefined || value.disabled !== undefined, "Choose a role or account status");
export const ssoSchema = z.object({
    enabled: z.boolean(),
    issuer: z.string().trim().max(2048),
    clientId: z.string().trim().max(500),
    clientSecret: z.string().max(4096).optional(),
    defaultRole: z.enum(["viewer", "editor"]),
    allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/)).max(100),
    passwordLoginEnabled: z.boolean(),
}).strict();
export type SsoSettings = Omit<z.infer<typeof ssoSchema>, "clientSecret"> & { clientSecret: string | null; verifiedUsers?: string[] };
export const DEFAULT_SSO_SETTINGS: SsoSettings = {
    enabled: false, issuer: "", clientId: "", clientSecret: null, defaultRole: "viewer", allowedEmailDomains: [], passwordLoginEnabled: true,
};
