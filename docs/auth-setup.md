# Phase 3 GitHub sign-in setup

These dashboard steps are needed because the configured application key cannot change Supabase authentication settings. Do not put the GitHub client secret in chat or browser code.

1. In Supabase, open **Authentication → Sign In / Providers → GitHub** and copy the callback URL shown there. It has the form `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
2. Open [GitHub OAuth Apps](https://github.com/settings/developers) and create an OAuth App:
   - Application name: `HuntSignal`
   - Homepage URL: `https://huntsignal.huntsignal.workers.dev`
   - Authorization callback URL: the exact Supabase callback URL copied in step 1.
   - Leave Device Flow disabled.
3. Copy the GitHub Client ID and generated Client Secret into the GitHub provider settings in Supabase, enable the provider, and save. These credentials belong in Supabase; HuntSignal does not need them in `.env`.
4. Under **Authentication → URL Configuration**, set the Site URL to `https://huntsignal.huntsignal.workers.dev` and add this exact redirect URL:

   `https://huntsignal.huntsignal.workers.dev/auth/callback`

   For optional local development against the hosted database, also allow:

   `http://127.0.0.1:5173/auth/callback`

5. Under **Settings → API Keys**, copy the **publishable** key (`sb_publishable_…`) and add it to the workspace's ignored `.env` file:

   ```dotenv
   SUPABASE_PUBLISHABLE_KEY=your_publishable_key
   ```

   A legacy `anon` key is also supported. Do not put the service-role/secret key in this setting.

6. Keep the existing `SUPABASE_URL` and backend key settings. Apply these files in order through Supabase's SQL Editor (skip ones already applied):
   - [004_query_planning.sql](../supabase/migrations/004_query_planning.sql)
   - [005_personal_library.sql](../supabase/migrations/005_personal_library.sql)
   - [006_personal_search_filters.sql](../supabase/migrations/006_personal_search_filters.sql)
7. Verify and deploy from the workspace:

   ```powershell
   npm run auth:check
   npm run auth:publish-config
   npm run deploy
   ```

   All three readiness checks should report true before deployment. The publishing helper transfers the browser-safe key through stdin; it never prints it or places it in process arguments. The normal build restricts the browser's Supabase connection to your exact project origin.

8. Open HuntSignal → **Sign in** → **Continue with GitHub**. Complete GitHub's authorization screen yourself, then create a bookmark and a private note. Sign out and verify your private library is no longer visible. Sign back in to check persistence.

For local UI development with real accounts, use `npm run dev:remote` and open `http://127.0.0.1:5173`. This uses the hosted database and its document IDs. `npm run dev` uses the independent local archive and keeps sign-in disabled.

The migrations create private library and alert tables. GitHub sign-in alone does not create those tables. If the SQL Editor reports an error, stop at that migration and retain the error text; don't drop existing tables or rerun the initial archive import.

Reference: [Supabase GitHub authentication](https://supabase.com/docs/guides/auth/social-login/auth-github).
