# Narrative Edge Function deployment contract

`generate-draft`, `review-draft`, and the browser `access` action of `run-schedules` validate bearer credentials inside the function through Supabase Auth. Their `verify_jwt = false` settings are therefore required: enabling gateway JWT verification would bypass the shared sanitized authentication-error path.

Before browser use, set `NARRATIVE_ADMIN_ORIGINS` in the Edge Function environment to a comma-separated list of exact origins, for example `https://admin.example.com,https://admin-preview.example.com`. Do not use wildcards, paths, query strings, or trailing slashes. Missing or invalid configuration fails closed for cross-origin requests.

The stock local Supabase Kong gateway may emit non-credentialed wildcard CORS metadata before or after the function. The handler still rejects disallowed actual requests before authentication or data access. For the forthcoming Vercel admin, prefer a same-origin server proxy if browser-direct gateway exposure must be eliminated.
