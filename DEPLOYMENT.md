# Public deployment on Render

## Before deployment

- Remove all real ID documents and personal test data from the repository.
- Change the admin password in `data/db.json`.
- Do not commit `private-verifications/` or `uploads/`.
- Use a managed database and private object storage before collecting real IDs. Render's local filesystem is not a permanent data store.

## Deploy

1. Push this folder to a private GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render reads `render.yaml` and creates the web service.
4. Wait for the deploy to finish, then open the generated `onrender.com` URL.
5. Set a strong admin password through the Admin Settings page.

## Verify the deployment

Open the generated URL on both desktop and mobile. Test:

- Main page and each tower page
- Admin login
- Concern creation with and without a photo
- ID verification and inline admin review
- Approval and publication into the thread
- Resolution and reopen workflow
- CSV export and analytics

## Important storage warning

This prototype uses `data/db.json`, `uploads/`, and `private-verifications/`. Render can recreate a service instance, so files stored there may disappear. Move concern data to PostgreSQL and public images to object storage; keep ID documents in encrypted private storage with an expiry/deletion policy before public use.
