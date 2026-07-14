# Value Vis Admin Web

Standalone research-ops dashboard for participant tracking.

This public repo contains only the admin web app, split out from the private
`value-vis` repo so GitHub Pages can publish it without exposing the full app.

```bash
npm install
npm run dev
```

Open `http://localhost:5174`, sign in with a Firebase account that has `admin: true` or
`study_admin: true` custom claims, a bootstrap admin email, or an email listed
in `admin_users/{email}`, then search by participant ID.

Use `localhost`, not `127.0.0.1`, for Google sign-in unless `127.0.0.1` has
also been added to Firebase Auth authorized domains.

## Publishing

Push to `main` to publish through GitHub Pages. The Pages workflow builds the
Vite app with `/value-vis-admin-web/` as its base path.

After the first deploy, set the repo's Pages source to **GitHub Actions** if
GitHub does not select it automatically. Add `mengyuanwu1.github.io` to Firebase
Authentication's authorized domains so Google sign-in works on the published
site.

Firebase web config is intentionally public in client apps. Data access still
depends on Firebase Auth plus Firestore security rules.

Bootstrap admin emails:

- `mw3209@columbia.edu`
- `mengyuanwu1@gmail.com`

Admins can add or remove non-bootstrap admin emails from the Admin Access panel
inside the dashboard. Deploy `frontend/firestore.rules` before using the panel
against the live Firebase project.

The main dashboard lets admins add participant IDs to their own roster. Saved
rosters live under:

- `admin_participant_rosters/{adminEmail}/participants/{participantId}`

Click a participant row to open the detailed tracking panels.

The dashboard reads:

- `users/{uid}.demo.participant_id`
- `users/{uid}.onboarding`
- `users/{uid}.integrations`
- `users/{uid}/health_days`
- `users/{uid}/daily_schedules`
- `users/{uid}/value_reflections`
