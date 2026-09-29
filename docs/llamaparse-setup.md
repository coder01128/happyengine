# LlamaParse and Claude API setup (for Brad)

You need this before the **live** parts of briefs 04–06: scanned PDFs, and the real-document gate test. Briefs 01–07 can all be built without it.

Checked on 29 Sep 2026. The portal's menus may have moved since; where a label differs, look for the nearest match.

## 1. Create a LlamaCloud account in the EU region

**The region can't be changed after the account is created.** Use the EU address, not the default one.

1. In your browser, go to **https://cloud.eu.llamaindex.ai**
2. Sign up with mr.bradk@gmail.com.
3. Once in, check the address bar still starts with `cloud.eu.`

The free plan gives 10,000 credits a month.

## 2. Create an API key

1. In the portal, open the **API Keys** page (left-hand menu).
2. Create a new key named `happyengine-local`.
3. Copy it right away. It's shown only once.

## 3. Get a Claude API key

1. In your browser, go to **https://console.anthropic.com**
2. Open **API Keys**, create a key named `happyengine-local`, and copy it.
3. Note the model ID you want the extractor to use, from https://docs.claude.com/en/docs/about-claude/models

## 4. Put the keys in the secrets file

This file is git-ignored, so the keys never reach GitHub.

1. Open a terminal and type:
   ```
   cd C:\ccode\git-repos\happyengine
   ```
   ```
   notepad supabase\functions\.env
   ```
   Notepad asks whether to create a new file. Click **Yes**.
2. Paste these lines, replacing each `PASTE_…` with your value:
   ```
   LLAMA_CLOUD_API_KEY=PASTE_LLAMA_KEY
   LLAMA_CLOUD_BASE_URL=https://api.cloud.eu.llamaindex.ai
   ANTHROPIC_API_KEY=PASTE_CLAUDE_KEY
   ANTHROPIC_MODEL=PASTE_MODEL_ID
   PARSER=fixture
   EXTRACTOR=fixture
   ALLOW_AS_AT_OVERRIDE=true
   ```
3. Save and close Notepad.
4. Back in the terminal, type:
   ```
   git check-ignore -v supabase\functions\.env
   ```
   You should see one line naming a `.gitignore` rule (for example `.gitignore:4:.env`) followed by the file's path. That means git is hiding it. **If nothing prints, stop.** The file isn't ignored. Tell Claude before committing anything.

`PARSER` and `EXTRACTOR` stay on `fixture` for normal development. Switch them to `llamaparse` and `claude` only for a live test on the synthetic samples.

## 4b. Put the LlamaParse key in Supabase (for the deployed functions)

The deployed edge functions read the key from Supabase, not from your `.env` file. LlamaParse keys only work in the region they were made in, so this must be the key from the **EU** site (section 2).

1. In your browser, open your Supabase project, then **Edge Functions**, then **Secrets** (in some layouts: Project Settings → Edge Functions).
2. Add two secrets: `LLAMA_CLOUD_API_KEY` (the key) and `LLAMA_CLOUD_BASE_URL` with the value `https://api.cloud.eu.llamaindex.ai`.
3. Add a third, `PARSER`, with the value `llamaparse`, only when you want the deployed functions to use LlamaParse. Without it they use the saved test parses. An organisation still needs `offshore_processing_approved` set by happyai before its files are sent.
4. Check the names were saved. In the terminal:
   ```
   cd C:\ccode\git-repos\happyengine
   ```
   ```
   supabase secrets list
   ```
   You should see a table with a NAME column listing `LLAMA_CLOUD_API_KEY` and `LLAMA_CLOUD_BASE_URL`, each with a long DIGEST string beside it. The digest is a fingerprint; the key itself is never shown. If it says the project isn't linked, tell Claude.

## 5. First live test (synthetic documents only)

After brief 04 is merged, in the same terminal:
```
node scripts/parse-file.ts eval\contracts\scan-marula\c2-subscription.pdf --parser llamaparse --tier agentic
```
You should see a page count, a word count and a credits estimate, and the saved file's path.

**Cost per eval run** = total pages × credits per page × $0.00125:
- cost-effective tier: 3 credits a page
- agentic tier: 10 credits a page

The eval reuses saved parses, so re-running costs nothing unless you add `--reparse`.

## 6. Email LlamaIndex before any real client document

Send this from mr.bradk@gmail.com to **support@runllama.ai**:

> Subject: DPA, subprocessors and Agentic tier models — EU account
>
> Hello,
>
> I run happyai, a South African document-processing service, on a LlamaCloud EU account (cloud.eu.llamaindex.ai). Before processing client documents I need:
>
> 1. Your Data Processing Agreement, including the clauses covering transfers of personal information from South Africa (POPIA section 72).
> 2. Your current subprocessor list with countries.
> 3. Which third-party AI models and providers the Agentic and Agentic Plus parse tiers use, and where they process data.
> 4. Confirmation that `disable_cache: true` means no copy of the file or output is kept after the job completes, and what retention applies to job metadata.
> 5. Whether granular word-level bounding boxes are available on the Free plan, or only on paid plans.
>
> Thank you,
> Brad Kruger

Save the reply with the POPIA template pack. Gate 2 in `docs/contracts-plan.md` depends on it.
