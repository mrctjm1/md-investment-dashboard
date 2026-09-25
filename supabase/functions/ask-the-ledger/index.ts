// "Ask the Ledger": answers a visitor's question about the dataset, grounded
// only in the current published records. The browser sends just { question };
// this function reads the live data and holds the Anthropic key server-side.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const MAX_QUESTION_CHARS = 500;
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

const SYSTEM_PROMPT = `You are answering questions about a real (not illustrative) dataset of Maryland investment records -- both private-sector capital investments and public-sector funding awards (grants, bonds, contracts, loans, tax credits) -- collected by a research pipeline with mandatory confidence and source tagging on every record, but no human review yet for some subsets. Answer ONLY from the records provided. Be honest about gaps and low-confidence entries, and be clear about which figures are private capital vs. public funding when relevant. Be concise unless the question needs a list. Reply in plain text, not Markdown.`;

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

// Deterministic (ordered by id, fixed field order) so the serialized dataset is
// byte-identical between requests and the prompt cache actually hits.
async function loadCompactRecords(): Promise<string> {
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
  const compact = rows.map((r) => ({
    type: r.type, company: r.company, name: r.name, category: r.category,
    state: r.state, county: r.county, place: r.place,
    record_type: r.recordType, funding_mechanism: r.fundingMechanism,
    awarding_level: r.awardingLevel, program_name: r.programName,
    status: r.status ?? r.completionStage, amount_usd: r.amount,
    confidence: r.confidence, amount_note: r.amountNote,
    jobs_new: r.jobsNew, jobs_retained: r.jobsRetained, jobs_construction: r.jobsConstruction,
    is_volatile: r.isVolatile, date: r.dateAnnounced,
  }));
  return `RECORDS (${compact.length}):\n${JSON.stringify(compact)}`;
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

  try {
    const records = await loadCompactRecords();
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        // Everything up to here is identical across questions -> cached.
        { type: "text", text: records, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: question.trim() }],
    });

    if (response.stop_reason === "refusal") {
      return json({ answer: "Sorry, I can't answer that question." }, 200, origin);
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    console.log(JSON.stringify({ usage: response.usage, stop_reason: response.stop_reason }));
    return json({ answer: text || "No answer returned." }, 200, origin);
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "The service is busy right now -- please try again in a minute." }, 503, origin);
    }
    return json({ error: "Something went wrong answering that question." }, 500, origin);
  }
});
