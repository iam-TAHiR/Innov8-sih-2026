# Innov8 — RPL assessment prototype

This self-contained Innov8 team demo implements a worker and assessor workflow for Smart India Hackathon problem statement 26242, “AI-Assisted Skill Assessment Tool for Recognition of Prior Learning (RPL).” It is prototype code in this folder and has not been pushed to the existing remote repository.

## What you can demonstrate

- The start screen separates the worker portal from the assessor workspace. In this prototype the role chooser is a demo gate only; it does not authenticate identities or securely restrict API data.
- A worker can type or speak a prior-work statement in a selected Indian language. The statement is saved in IndexedDB and, when online, sent to the backend for rule-based extraction and preliminary semantic module retrieval.
- Optional photo intake adds a device-reported UTC timestamp and, with worker permission, approximate GPS coordinates. It is worker-submitted and is not verified proof of presence or competence.
- Pending worker intakes and assessor ratings retry when connectivity returns. Stable record IDs make server retries idempotent.
- A downloadable preliminary skill profile PDF summarizes the statement, suggested modules, and entered ratings. It is marked unofficial and is not a certificate.
- An assessor scores a practical checklist using four ratings: demonstrated, partially demonstrated, not demonstrated, or not observed. Evidence prompts are shown in tool-assisted mode.
- A manual-baseline mode hides the extraction, module suggestions, and prompts so the same checklist can be rated without those aids.
- Five fictional test cases and separate local drafts for each case and mode let a team collect matched comparison records without mixing case ratings.
- The assessor records a human recommendation (pending, recommend for certification review, request more evidence, or not recommending yet). The prototype never awards a qualification, decides pass/fail, or replaces the authorized assessor.
- Synced records are stored in a local JSON file. The consistency view reports exact agreement between different assessor names on the same case and shows assisted-versus-manual changes only when the same assessor pair has records in both modes.
- The app shell, worker/checklist reference data, worker statement drafts, optional photo, and queued assessor ratings are available offline after the first online load. Extraction/matching and server sync require the backend; voice dictation can require a browser service connection.
- Worker web intake is separate from assessor scoring. The demo has no real worker/assessor accounts, authentication, or secure role-based API permissions yet.
- A Meta WhatsApp Cloud API webhook scaffold supports signed webhook verification, explicit chat consent, text intake, voice-note media download, and optional transcription using OpenAI when configured. It cannot receive messages until you configure Meta credentials and expose this API through a public HTTPS callback URL.

## Qualification source

The active demo uses the NCVET National Qualification Register entry “Assistant Electrician (Domestic cum Industrial),” code `QG-03-PW-02422-2024-V1-MSME`, NSQF Level 3. The checklist is a prototype subset adapted from the qualification file assessment criteria. Module suggestions use a multilingual Sentence Transformers model when available; otherwise the API reports a transparent token-overlap fallback. Similarity is an uncalibrated retrieval hint, not a probability or competency score. The earlier `PSS/Q6001` file remains only as legacy reference data and is not used by the active API.

- [NQR qualification page](https://www.nqr.gov.in/qualifications/10741)
- [Qualification file](https://www.nqr.gov.in/qualification/file/Assistant%20Electrician%20(Domestic%20cum%20Industrial)_%20QF.pdf)

The prototype checklist includes selected criteria from MSME/DIE/01–03 and all 17 performance criteria listed for MSME/DIE/04 (Transformer Testing and Maintenance), adapted into assessor-facing items. Verify the official qualification file and approved assessment strategy before using these cards for a real assessment. Electrical practical work must be assessed by a qualified person using approved equipment and safety controls. Transformer practical work must use isolated, de-energized training equipment and qualified supervision. The prompts in this demo are not a substitute for an approved assessment plan or official rubric.

## Run on Windows

Open two PowerShell windows in the project folder.

**Window 1 — API**

```powershell
cd "prototype\backend"
\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

If the virtual environment does not exist, create it and install the listed packages once. The embedding dependency is large; the configured multilingual model is downloaded on first semantic matching request unless already cached. Until then, the API remains available and labels fallback matching clearly.

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

**Window 2 — web app**

```powershell
cd "prototype\frontend"
npm.cmd install
npm.cmd run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173/`. Keep both windows open. The `.cmd` form works around PowerShell’s script execution policy when `npm.ps1` is blocked.

## Suggested paired demo

1. Open the app once while online and let the worker/checklist reference data load.
2. Select one fictional test case. Both assessors should use precisely the same displayed name in **Assessor name** for the corresponding comparison (for example, “Assessor A” and “Assessor B”). Each assessor independently rates the same checklist; do not copy the other person’s ratings.
3. Save both assessor records in **Manual baseline** mode. Use the same case and criterion set.
4. Switch to **Tool-assisted** mode and have both assessors independently rate that same case again. The app keeps the two modes’ drafts separate.
5. Review **Assessor consistency**. “Matched comparison” is computed only for cases where both named assessors have a record in both modes. A positive or negative change is descriptive for this demo sample; it does not establish general effectiveness.
6. To show offline behavior, let the app load once while online, take the browser offline, submit a worker statement and assessor ratings, refresh, and confirm both remain queued. Reconnect; queued records retry automatically. A queued record is not server-saved until sync succeeds.

## API routes

- `GET /health`, `GET /workers`
- `POST /skills/extract`, `POST /matching/preview`, `GET /matching/status`
- `POST /workers/intake`, `GET /workers/intake`, `GET /workers/intake/{intake_id}/evidence`
- `GET /webhooks/whatsapp`, `POST /webhooks/whatsapp`, `GET /whatsapp/status`
- `GET /assessment/checklist`
- `POST /assessment/score-preview` (preview only)
- `POST /assessment/sync` (explicitly appends the submitted record)
- `GET /assessment/records`, `GET /assessment/consistency`
- `GET /docs` (interactive API documentation)

## Data and prototype limits

- Worker names and profiles are fictional. Do not enter real personal, employment, or assessment data.
- Skill extraction still uses hard-coded demo rules and recognizes a few English phrases (wiring, MCB, fan) and numeric year statements. Semantic module suggestions do not assess competence.
- The role chooser is a local demo gate, not login or authorization; the API is not protected by role permissions. There is no production database, encryption, backup, full speech-to-text service, video/image skill evaluation, or real-time multi-user coordination. The WhatsApp webhook is only a scaffold until Meta credentials and a public HTTPS callback are configured; voice-note transcription additionally needs an OpenAI API key.
- Browser drafts and queues live in IndexedDB. Synced demo records append to local JSON files (`backend/data/assessment_records.json` and `backend/data/worker_intakes.json`); keep these files if you need demo history. This is not a production store. Do not enter sensitive real-worker data.
- The consistency calculations are exact agreement on common rated criteria; “not observed” is excluded. The latest record for each assessor/case/qualification/mode is used. The manual/assisted comparison requires the same two assessor names and same case in both modes, and compares only checklist criteria with usable ratings in both modes.
- A small, unbalanced sample cannot substantiate improvement over manual scoring. Collect a planned test set, same-case paired ratings, and a suitable baseline before making that claim.
- No official certification decision is produced. An authorized assessor and certification body retain responsibility for evidence, competency decisions, and certification.
