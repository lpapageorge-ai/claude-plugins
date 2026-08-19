---
description: Check the Procore connection and show the companies/projects the service account can access.
---

Verify the Procore connection and give me a quick overview:

1. Call `procore_whoami` to confirm the service account is authenticated. If it fails,
   diagnose the likely cause (missing/invalid credentials, wrong environment) and point
   me to the fix in the plugin README.
2. Call `procore_list_companies` and show the company names + ids.
3. For the default company (or the first one if no default is configured), call
   `procore_list_projects` and show the first ~20 active projects with their ids.

Present it as a compact summary. Don't make any write calls.
