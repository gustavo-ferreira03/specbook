# Accounts and single sign-on

Specbook accounts have instance-wide roles. Viewers read projects and results; editors also change specs, run checks and use the agent. Administrators manage members, model credentials, security settings and operations. The first visitor creates the administrator account during setup, including on an existing installation with no accounts yet.

## Connect an identity provider

In **Settings → Single sign-on**, enter the issuer, client ID and client secret. Register this exact callback on the provider, replacing the example origin with the URL people use to open Specbook:

```text
https://specbook.example.com/api/auth/oidc/callback
```

Use a confidential web application with the authorization-code grant. Specbook requests `openid email profile`, adds PKCE, and validates the issuer, signature, audience, state and nonce. Enter the issuer itself, without `/.well-known/openid-configuration`. The backend must reach its discovery document, signing keys and token endpoint.

Choose Viewer or Editor as the role for new SSO accounts; administrators assign higher permissions in **Members**. Allowed email domains match exactly, so `example.com` does not include subdomains. An empty list accepts any verified email that the configured provider supplies. Configure provider-side app assignments as well.

Save while password sign-in remains enabled, then open your account menu and select **Connect single sign-on**. Sign in to the provider with the same email as your existing account. Specbook never links accounts solely because their emails match; subsequent logins identify the account by issuer and subject.

After that successful connection, an administrator can disable password sign-in. Changing the issuer, client ID or secret requires a fresh successful connection before disabling passwords again. Specbook also prevents disabling or demoting the last administrator with a working configured login method. Keep password access while testing a provider change.

## Provider settings

### Google

Create a **Web application** OAuth client, register the callback above, then use `https://accounts.google.com` as the issuer and copy the client credentials into Specbook. Google documents `email_verified` in its [OpenID Connect claims reference](https://developers.google.com/identity/openid-connect/reference); the [server flow guide](https://developers.google.com/identity/openid-connect/openid-connect) covers client registration. Specbook's domain filter checks the email domain and does not interpret Google's `hd` claim as a Workspace organization policy.

### Microsoft Entra ID

Register a web application for one tenant and configure the callback. Use `https://login.microsoftonline.com/<tenant-GUID>/v2.0` as the issuer; `common` and `organizations` are unsuitable for this tenant-specific configuration. Copy the application client ID and the secret **value**. See Microsoft's [OIDC protocol documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc).

Configure the optional ID-token claims `email` and `xms_edov`, and restrict allowed domains in Specbook. This integration accepts `xms_edov: true` only from the exact configured tenant-GUID issuer after token validation. Microsoft defines it as email-domain verification and requires the `email` claim; some account types do not provide a true value. Those accounts cannot use this path. Specbook does not accept `email` or `preferred_username` alone as verification. See the [optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).

### Okta

Create an **OIDC Web Application**, register the callback, and assign the intended users or groups. Use the org issuer `https://<your-domain>.okta.com`, or the exact issuer of an existing custom authorization server, with that application's client ID and secret. Okta documents both [web application registration](https://developer.okta.com/docs/guides/sign-into-web-app-redirect/main/) and [issuer formats](https://developer.okta.com/docs/concepts/auth-servers/). The selected server must return `email` and `email_verified: true` in the ID token or UserInfo response; an email attribute by itself is insufficient.

### Keycloak

Create an OpenID Connect client in the intended realm, enable client authentication and Standard Flow, register the callback, and copy its credentials. Use `https://<keycloak-host>/realms/<realm>` as the issuer; Keycloak publishes discovery under that realm's [OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers). Include the `email` client scope and require users to verify their email, following the [server administration guide](https://www.keycloak.org/docs/latest/server_admin/index.html). Specbook requires `email_verified: true`.

## Invitations, sessions and troubleshooting

Administrators can create invitation links in **Members** and share them directly. Links expire after seven days and work once; Specbook stores their hashes. Password invitations cannot be created or accepted while password sign-in is disabled. New SSO members sign in through the provider, after which an administrator can change their role.

Sessions expire after seven days. Signing out revokes the current session; disabling an account or changing its role revokes all its sessions, including open activity streams and browser connections. Specbook sign-out does not end the provider's session. HTTPS deployments use Secure, HttpOnly cookies with the `__Host-` prefix.

If a callback fails, check the exact redirect URI, verified email claims, domain filter and client secret. Start again after changing settings; callback state expires after ten minutes and cannot be reused. Administrators can correlate the failed SSO event in **Audit log** with its error ID in the backend log. Token and client-secret values do not appear in audit records.

Verification used Dex v2.45.1 as a real local provider: explicit administrator linking, logout and fresh SSO login with passwords disabled, new Viewer provisioning and denied admin access all passed. The integration tests also reject invalid signatures, mismatched nonce, reused state, missing browser cookies, unverified emails and implicit email linking. The provider recipes above follow their official documentation; they have not all been exercised against live tenant accounts.

Local provider development can set `SPECBOOK_OIDC_ALLOW_HTTP=1`; this permits HTTP issuers only on `localhost`, `127.0.0.1` or `::1`. Keep HTTPS for shared deployments.
