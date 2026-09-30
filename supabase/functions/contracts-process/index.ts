// POST { agreementId, retry? } — moves one agreement one step along its way and returns the new status.
//   uploaded → parsing   the originals are read, checked and sent to the parser
//   parsing  → parsed    each file's result is fetched; its pages and word positions are stored
//   failed + retry: true → uploaded
// The app calls again every 3 seconds while the status is `parsing`, because an edge function can't wait
// for a long parse. Reading the pages is as far as this goes for now; recording the terms comes next.
// Nothing is ever sent to anyone: files go to the parser only when the organisation is approved for it.
//
// Environment: PARSER (fixture | llamaparse, default fixture), LLAMA_CLOUD_API_KEY, LLAMA_CLOUD_BASE_URL.

import { PDFDocument } from 'npm:pdf-lib@1.17.1';
import {
  advanceParse, chooseParser, OffshoreNotApproved, ParseProblem, ParserError, sha256Hex, validateContractsPreset,
  type FileRow, type ParseStore, type StoredPage,
} from '../_shared/contracts.ts';
import { HttpError, handle, json, loadAgreement, readIdField, requireRole, requireUser } from '../_shared/http.ts';

Deno.serve(
  handle(async (req) => {
    const { user, admin } = await requireUser(req);
    const { id: agreementId, body } = await readIdField(req, 'agreementId');
    const agreement = await loadAgreement(admin, agreementId);
    await requireRole(admin, agreement.org_id, user.id, ['uploader', 'reviewer', 'admin'], 'Agreement');

    // The preset as it was when processing began, or the current one if processing hasn't begun.
    let config = agreement.preset_snapshot;
    if (!config) {
      const { data, error } = await admin.from('presets').select('config').eq('id', agreement.preset_id).single();
      if (error) throw error;
      config = data.config;
    }
    let preset;
    try {
      preset = validateContractsPreset(config);
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }

    const { data: org, error: orgError } = await admin.from('orgs').select('offshore_processing_approved').eq('id', agreement.org_id).single();
    if (orgError) throw orgError;
    const { data: files, error: filesError } = await admin
      .from('agreement_files')
      .select('id, org_id, agreement_id, ord, storage_path, filename, parse_job_id, parse_status, file_sha256')
      .eq('agreement_id', agreementId)
      .order('ord');
    if (filesError) throw filesError;

    let parser;
    try {
      parser = chooseParser(
        { PARSER: Deno.env.get('PARSER') ?? undefined, LLAMA_CLOUD_API_KEY: Deno.env.get('LLAMA_CLOUD_API_KEY') ?? undefined, LLAMA_CLOUD_BASE_URL: Deno.env.get('LLAMA_CLOUD_BASE_URL') ?? undefined },
        {
          offshoreAllowed: org.offshore_processing_approved === true,
          versions: preset.parser.versions,
          // Saved parses for local testing live in the private parse-artifacts bucket, never the documents bucket.
          async readFixture(filename) {
            const { data, error } = await admin.storage.from('parse-artifacts').download(`${agreement.org_id}/${agreementId}/_fixtures/${filename}.parsed.json`);
            return error || !data ? null : await data.text();
          },
        },
      );
    } catch (err) {
      if (err instanceof OffshoreNotApproved) throw new HttpError(403, "This organisation isn't approved for cloud processing yet.");
      if (err instanceof ParserError) throw new HttpError(422, err.message);
      throw err;
    }

    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new HttpError(409, error.message);
      return data;
    };
    const store: ParseStore = {
      async pinFile(fileId, sha256) {
        await rpc('contracts_pin_file', { p_file: fileId, p_sha256: sha256 });
      },
      claim: (id, actor, p) => rpc('contracts_claim_parse', { p_agreement: id, p_actor: actor, p_preset: p }),
      async recordSubmitted(fileId, actor, x) {
        await rpc('contracts_record_submitted', {
          p_file: fileId, p_actor: actor, p_job_id: x.jobId, p_parser: x.parser, p_tier: x.tier, p_pages: x.pages,
          p_sha256: x.sha256, p_credits_estimate: x.creditsEstimate,
        });
      },
      storeParsedFile: (fileId, actor, pages: StoredPage[], meta) =>
        rpc('contracts_store_parsed_file', {
          p_file: fileId, p_actor: actor, p_pages: pages,
          p_meta: { version: meta.version ?? null, credits: meta.credits ?? null, sidecar_path: meta.sidecarPath ?? null },
        }),
      async fail(id, actor, error) {
        await rpc('contracts_fail', { p_agreement: id, p_actor: actor, p_error: error });
      },
      async retry(id, actor) {
        await rpc('contracts_retry', { p_agreement: id, p_actor: actor });
      },
      async status(id) {
        return (await loadAgreement(admin, id)).status as string;
      },
    };

    const outcome = await advanceParse(
      {
        store,
        parser,
        async download(path) {
          const { data, error } = await admin.storage.from('documents').download(path);
          if (error || !data) throw new ParseProblem('An uploaded file could not be read from storage.');
          return new Uint8Array(await data.arrayBuffer());
        },
        async putArtifact(path, text) {
          const { error } = await admin.storage.from('parse-artifacts').upload(path, new Blob([text], { type: 'application/x-ndjson' }), { upsert: true });
          if (error) throw error;
        },
        async countPages(bytes) {
          try {
            return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
          } catch {
            throw new ParseProblem('A file could not be read as a PDF.');
          }
        },
        sha256: sha256Hex,
      },
      { agreement, files: files as FileRow[], preset, actor: user.id, retry: body?.retry === true },
    );
    return json(200, outcome);
  }),
);
