// "Ask the Ledger": answers a visitor's question about the dataset, grounded
// only in the current published records. The browser sends just { question };
// this function reads the live data and holds the Anthropic key server-side.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic, { toFile } from "npm:@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";
const MAX_QUESTION_CHARS = 500;
const MAX_PAUSE_RESUMES = 3;
const ALLOWED_ORIGINS = new Set([
  "https://mrctjm1.github.io",
  "http://127.0.0.1:8765", // local testing
  "http://localhost:8765",
]);

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
// The anon key can read only md_dashboard.records (published rows) -- no
// service-role key needed, so this function has no more access than the site.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,
  { db: { schema: "md_dashboard" } },
);

const SYSTEM_PROMPT = `You answer questions about a real (not illustrative) dataset of Maryland investment records -- both private-sector capital investments and public-sector funding awards (grants, bonds, contracts, loans, tax credits) -- collected by a research pipeline with mandatory confidence and source tagging on every record, but no human review yet for some subsets.

The full dataset is attached as records.csv, one row per record. Always compute answers with code (e.g. pandas) against that file -- never estimate counts, totals, or rankings. Columns:
- type: private_investment (a company's own capital decision) or public_investment (a government funding award)
- company: company or award recipient; name: project or award name
- category: industry sector (private) or purpose (public)
- state, county, place: location. "Maryland (county unspecified)" means the source only confirmed the state.
- record_type (private only): completed_transaction, future_projection, multiyear_program, recurring_subsidy_award, approved_contested
- funding_mechanism, awarding_level, awarding_agency, program_name, fiscal_year: public awards only
- status, completion_stage: progress of the project
- amount_usd: dollars; blank means undisclosed (not zero)
- confidence: high / medium / low confidence in the dollar figure; amount_note explains it
- jobs_new, jobs_retained, jobs_construction, jobs_note: job figures where known
- is_volatile: true if the figure is disputed or likely to change
- date: announcement or award date

Answer ONLY from this data. Be honest about gaps and low-confidence entries, and be clear about which figures are private capital vs. public funding. Keep the final answer concise (a list if the question needs one), in plain text, not Markdown, and don't describe your code or method unless asked.`;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://mrctjm1.github.io",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const CSV_COLUMNS: [string, string][] = [
  ["type", "type"], ["company", "company"], ["name", "name"], ["category", "category"],
  ["state", "state"], ["county", "county"], ["place", "place"],
  ["record_type", "recordType"], ["funding_mechanism", "fundingMechanism"],
  ["awarding_level", "awardingLevel"], ["awarding_agency", "awardingAgency"],
  ["program_name", "programName"], ["fiscal_year", "fiscalYear"],
  ["status", "status"], ["completion_stage", "completionStage"],
  ["amount_usd", "amount"], ["confidence", "confidence"], ["amount_note", "amountNote"],
  ["jobs_new", "jobsNew"], ["jobs_retained", "jobsRetained"],
  ["jobs_construction", "jobsConstruction"], ["jobs_note", "jobsNote"],
  ["is_volatile", "isVolatile"], ["date", "dateAnnounced"],
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function loadRecordsCsv(): Promise<string> {
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("records")
      .select("*")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const lines = [CSV_COLUMNS.map(([header]) => header).join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, key]) => csvCell(r[key])).join(","));
  return lines.join("\n") + "\n";
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  let question: unknown;
  try {
    ({ question } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400, origin);
  }
  if (typeof question !== "string" || !question.trim()) {
    return json({ error: "Missing question" }, 400, origin);
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json({ error: `Please keep questions under ${MAX_QUESTION_CHARS} characters.` }, 400, origin);
  }

  let fileId: string | null = null;
  try {
    const csv = await loadRecordsCsv();
    const uploaded = await anthropic.files.upload({
      file: await toFile(new TextEncoder().encode(csv), "records.csv", { type: "text/csv" }),
    });
    fileId = uploaded.id;

    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: [
        { type: "text", text: question.trim() },
        { type: "container_upload", file_id: fileId },
      ],
    }];
    let response: Anthropic.Message;
    for (let resumes = 0; ; resumes++) {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        messages,
      });
      // Long server-side tool runs pause; resend the turn as-is to continue.
      if (response.stop_reason !== "pause_turn" || resumes >= MAX_PAUSE_RESUMES) break;
      messages.push({ role: "assistant", content: response.content });
    }
    console.log(JSON.stringify({ usage: response.usage, stop_reason: response.stop_reason }));

    if (response.stop_reason === "refusal") {
      return json({ answer: "Sorry, I can't answer that question." }, 200, origin);
    }
    // The final answer is the text after the last tool call (earlier text is
    // the model narrating its work).
    const lastTool = response.content.findLastIndex((b) => b.type !== "text");
    const text = response.content
      .slice(lastTool + 1)
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return json({ answer: text || "No answer returned." }, 200, origin);
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "The service is busy right now -- please try again in a minute." }, 503, origin);
    }
    return json({ error: "Something went wrong answering that question." }, 500, origin);
  } finally {
    if (fileId) anthropic.files.delete(fileId).catch((e) => console.error("file cleanup failed", e));
  }
});
