import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_IPERAMMORTAMENTO_MODEL") || "gemini-2.0-flash";
const GEMINI_FALLBACK_MODELS = Array.from(new Set([
  GEMINI_MODEL,
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
]));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type IncomingDocument = { fileName: string; mimeType: string; base64: string };
type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status });
}

function cleanBase64(value: string) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiStatus(errorText: string) {
  try {
    const parsed = JSON.parse(errorText);
    return { status: String(parsed?.error?.status || parsed?.status || ""), code: Number(parsed?.error?.code || parsed?.code || 0) };
  } catch {
    return { status: "", code: 0 };
  }
}

function friendlyError(errorText: string, fallback: string) {
  const parsed = geminiStatus(errorText);
  if (parsed.status === "UNAVAILABLE" || parsed.code === 503) return "Gemini è temporaneamente sovraccarico. Riprova tra qualche minuto.";
  if (parsed.status === "RESOURCE_EXHAUSTED" || parsed.code === 429) return "Limite temporaneo Gemini raggiunto. Attendi qualche minuto e riprova.";
  return fallback;
}

function normalizeMoney(value: unknown) {
  const raw = String(value || "").trim().replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  if (!raw) return "";
  return raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
}

function normalizeDate(value: unknown) {
  const raw = String(value || "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const italian = raw.match(/\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\b/);
  if (!italian) return "";
  return `${italian[3].length === 2 ? `20${italian[3]}` : italian[3]}-${italian[2].padStart(2, "0")}-${italian[1].padStart(2, "0")}`;
}

function normalizeDescription(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 110);
}

function normalizeAcceptedRows(value: unknown, sourceFileNames: string[]) {
  const rows = (value as { acceptedRows?: Array<Record<string, unknown>> })?.acceptedRows;
  if (!Array.isArray(rows)) return [];
  const expectedByKey = new Map(sourceFileNames.map((name) => [name.toLowerCase(), name]));
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  rows.forEach((row) => {
    const documentType = String(row.documentType || "").toUpperCase();
    const sourceFileName = expectedByKey.get(String(row.sourceFileName || "").trim().toLowerCase());
    if (!["FATTURA", "PREVENTIVO"].includes(documentType) || !sourceFileName) return;
    grouped.set(sourceFileName, [...(grouped.get(sourceFileName) || []), row]);
  });
  if (!grouped.size) return [];
  const scopeRank = (row: Record<string, unknown>) => String(row.amountScope || "") === "DOCUMENT_TOTAL" ? 2 : String(row.amountScope || "") === "SUM_OF_LINES" ? 1 : 0;
  return [...grouped.entries()].map(([sourceFileName, validRows]) => {
    const selected = [...validRows].sort((left, right) => scopeRank(right) - scopeRank(left) || Number(normalizeMoney(right.taxableAmount)) - Number(normalizeMoney(left.taxableAmount)))[0];
    const amountScope = ["DOCUMENT_TOTAL", "SUM_OF_LINES", "UNCERTAIN"].includes(String(selected.amountScope)) ? String(selected.amountScope) : "UNCERTAIN";
    const amountEvidence = normalizeDescription(selected.amountEvidence);
    const amountPage = Math.max(0, Math.floor(Number(selected.amountPage || 0)));
    // Only a traceable document total can enter the simulation total automatically.
    const taxableAmount = amountScope === "DOCUMENT_TOTAL" && amountEvidence && amountPage ? normalizeMoney(selected.taxableAmount) : "";
    const multipleRows = validRows.length > 1;
    return {
      id: `iper-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sourceFileName: sourceFileName.slice(0, 180),
      documentType: String(selected.documentType || "").toUpperCase(),
      supplier: String(selected.supplier || "").trim().slice(0, 160),
      documentNumber: String(selected.documentNumber || "").trim().slice(0, 100),
      documentDate: normalizeDate(selected.documentDate),
      taxableAmount,
      amountScope,
      amountEvidence,
      amountPage,
      description: normalizeDescription(selected.description),
      confidence: Math.max(0, Math.min(1, Number(selected.confidence || 0))),
      needsReview: Boolean(selected.needsReview) || multipleRows || amountScope !== "DOCUMENT_TOTAL" || !taxableAmount || !amountEvidence || !amountPage || !String(selected.description || "").trim(),
      eligibility: ["POTENZIALMENTE_IDONEO", "DA_VERIFICARE", "NON_CHIARO"].includes(String(selected.eligibility)) ? String(selected.eligibility) : "DA_VERIFICARE",
      eligibilityNote: multipleRows ? "Rilevate più voci nel file: è stato selezionato un solo totale imponibile. Verifica l'importo." : normalizeDescription(selected.eligibilityNote),
      extractionSource: "AI",
    };
  });
}

function normalizeDiscarded(value: unknown) {
  const rows = (value as { discardedDocuments?: Array<Record<string, unknown>> })?.discardedDocuments;
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    id: `iper-discard-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    sourceFileName: String(row.sourceFileName || `documento-${index + 1}`).slice(0, 180),
    detectedType: String(row.detectedType || "NON RICONOSCIUTO").slice(0, 80),
    reason: normalizeDescription(row.reason || "Documento non utilizzabile per la simulazione."),
  }));
}

function extractionPrompt() {
  return [
    "Sei un analista contabile italiano che prepara dati per una simulazione di iperammortamento 2026.",
    "Analizza con estrema attenzione i PDF e le immagini allegati.",
    "ACCETTA ESCLUSIVAMENTE fatture, preventivi e offerte commerciali/economiche riferite a beni o impianti. Le offerte commerciali valide devono essere classificate come PREVENTIVO.",
    "Un'offerta e' valida quando identifica una proposta economica concreta, con fornitore e beni/servizi quotati oppure importi economici riconducibili ai beni. Anche se il titolo usa solo 'Offerta', 'Proposta' o 'Quotazione', accettala come PREVENTIVO se soddisfa questi criteri.",
    "SCARTA pro-forma, DDT, ordini, conferme d'ordine, contratti privi di quotazione dei beni, ricevute, documenti tecnici e file non leggibili.",
    "RESTITUISCI ESATTAMENTE ZERO O UNA SOLA RIGA PER CIASCUN FILE RICEVUTO. Non creare una riga per pagina, bene, capitolo, riga di preventivo, aliquota IVA o subtotale.",
    "Se il documento contiene più beni, crea comunque una sola riga: usa l'imponibile complessivo del documento e una descrizione sintetica che riassuma i beni principali.",
    "",
    "Per l'unica riga accettata estrai: sourceFileName, documentType (FATTURA o PREVENTIVO), supplier, documentNumber, documentDate YYYY-MM-DD, taxableAmount, amountScope, amountEvidence, amountPage, description, confidence, needsReview, eligibility, eligibilityNote.",
    "taxableAmount deve essere esclusivamente il totale imponibile/base imponibile/totale netto dell'intero documento, mai un singolo importo di riga. Privilegia le voci 'Totale imponibile', 'Imponibile totale' o 'Totale netto'. amountEvidence deve riportare la dicitura esatta e breve letta nel PDF che prova l'importo, per esempio 'TOTALE IMPONIBILE EUR 25.137,50'; amountPage e' il numero della pagina PDF in cui appare (1, 2, 3...). Non inventare mai prova o pagina.",
    "Se il totale non e' esplicito ma sommi con certezza le righe nette, usa amountScope=SUM_OF_LINES, amountEvidence='Somma di righe nette' e needsReview=true. Se non puoi identificare una dicitura di totale attendibile, lascia taxableAmount vuoto, amountScope=UNCERTAIN, amountEvidence vuoto e needsReview=true. Non includere IVA, bolli, ritenute, spese incasso, arrotondamenti, totali lordi o singoli importi di riga.",
    "Se un preventivo o un'offerta non espone IVA, usa il totale solo se è chiaramente netto; altrimenti needsReview=true.",
    "description: scrivi una sola descrizione umana, breve e chiara di 5-10 parole. Riformula il contenuto: non copiare frasi, codici di prodotto, condizioni commerciali, elenchi tecnici o testo esteso dal documento. Indica la tipologia funzionale del bene, ad esempio 'Sistema automatizzato per lavorazioni produttive' o 'Impianto fotovoltaico con accumulo energetico', senza inventare dati.",
    "eligibility: POTENZIALMENTE_IDONEO quando sono descritti beni produttivi/digitali/tecnologici potenzialmente riconducibili all'iperammortamento; DA_VERIFICARE quando serve una verifica tecnica; NON_CHIARO quando il bene non è leggibile o non valutabile. Non escludere una fattura/preventivo soltanto per eligibility.",
    "eligibilityNote: breve motivo dell'avviso o verifica richiesta.",
    "needsReview=true quando imponibile, descrizione, fornitore, numero o data sono incerti/mancanti oppure quando hai dovuto usare un importo non esplicitamente indicato come imponibile.",
    "",
    "Per ogni documento scartato aggiungi sourceFileName, detectedType e reason. Indica chiaramente il motivo dello scarto.",
    "Non inventare alcun valore. Il sourceFileName deve essere esattamente uno dei file ricevuti.",
    "Restituisci solo JSON conforme allo schema.",
  ].join("\n");
}

const responseSchema = {
  type: "object",
  properties: {
    acceptedRows: { type: "array", items: { type: "object", properties: {
      sourceFileName: { type: "string" }, documentType: { type: "string", enum: ["FATTURA", "PREVENTIVO"] }, supplier: { type: "string" }, documentNumber: { type: "string" }, documentDate: { type: "string" }, taxableAmount: { type: "string" }, amountScope: { type: "string", enum: ["DOCUMENT_TOTAL", "SUM_OF_LINES", "UNCERTAIN"] }, amountEvidence: { type: "string" }, amountPage: { type: "number" }, description: { type: "string" }, confidence: { type: "number" }, needsReview: { type: "boolean" }, eligibility: { type: "string", enum: ["POTENZIALMENTE_IDONEO", "DA_VERIFICARE", "NON_CHIARO"] }, eligibilityNote: { type: "string" },
    }, required: ["sourceFileName", "documentType", "supplier", "documentNumber", "documentDate", "taxableAmount", "amountScope", "amountEvidence", "amountPage", "description", "confidence", "needsReview", "eligibility", "eligibilityNote"] } },
    discardedDocuments: { type: "array", items: { type: "object", properties: { sourceFileName: { type: "string" }, detectedType: { type: "string" }, reason: { type: "string" } }, required: ["sourceFileName", "detectedType", "reason"] } },
  },
  required: ["acceptedRows", "discardedDocuments"],
};

async function generate(parts: GeminiPart[]) {
  let lastErrorText = "";
  let lastStatus = 500;
  for (const model of GEMINI_FALLBACK_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(endpoint, { method: "POST", headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.05, topP: 0.2, topK: 20, responseMimeType: "application/json", responseJsonSchema: responseSchema } }) });
      if (response.ok) return await response.json();
      lastStatus = response.status;
      lastErrorText = await response.text();
      const parsed = geminiStatus(lastErrorText);
      if (response.status === 404 || parsed.status === "NOT_FOUND") break;
      const temporary = [429, 500, 502, 503, 504].includes(response.status) || ["UNAVAILABLE", "RESOURCE_EXHAUSTED"].includes(parsed.status);
      if (!temporary) throw new Error(friendlyError(lastErrorText, `Gemini: ${lastErrorText}`));
      if (response.status === 503) break;
      await sleep(900 * (attempt + 1) + Math.floor(Math.random() * 500));
    }
  }
  throw new Error(friendlyError(lastErrorText, `AI temporaneamente non disponibile (${lastStatus})`));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY non configurata" }, 500);
  try {
    const body = await req.json();
    const documents = (body.documents || []) as IncomingDocument[];
    if (!Array.isArray(documents) || !documents.length) return jsonResponse({ error: "Nessun documento ricevuto" }, 400);
    if (documents.length > 12) return jsonResponse({ error: "Carica massimo 12 documenti per analisi" }, 400);
    const parts: GeminiPart[] = [{ text: extractionPrompt() }];
    for (const document of documents) {
      const base64 = cleanBase64(document.base64);
      if (!document.fileName || !base64) return jsonResponse({ error: `File non valido o vuoto: ${document.fileName || "senza nome"}` }, 400);
      parts.push({ text: `\n--- FILE: ${document.fileName} ---` });
      parts.push({ inlineData: { mimeType: document.mimeType || "application/pdf", data: base64 } });
    }
    const result = await generate(parts);
    const outputText = result.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!outputText) return jsonResponse({ error: "Risposta Gemini vuota" }, 500);
    const payload = JSON.parse(outputText);
    const acceptedRows = normalizeAcceptedRows(payload, documents.map((document) => document.fileName));
    const acceptedNames = new Set(acceptedRows.map((row) => String(row.sourceFileName).toLowerCase()));
    const discardedDocuments = normalizeDiscarded(payload);
    const discardedNames = new Set(discardedDocuments.map((row) => String(row.sourceFileName).toLowerCase()));
    documents.forEach((document) => {
      const key = document.fileName.toLowerCase();
      if (!acceptedNames.has(key) && !discardedNames.has(key)) discardedDocuments.push({ sourceFileName: document.fileName, detectedType: "DA VERIFICARE", reason: "Nessun totale imponibile affidabile individuato nel file." });
    });
    return jsonResponse({ acceptedRows, discardedDocuments });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
